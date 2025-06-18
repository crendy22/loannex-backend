// Enhanced backend API: /api/trigger-loan-with-status.js
// Complete version with Prepay Penalty error handling
// Updated for full lock status monitoring

export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { loanData, loanIndex, credentials } = req.body;
        
        if (!loanData || !credentials) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required loan data or credentials' 
            });
        }

        console.log(`Processing loan ${loanIndex} with workflow monitoring for user: ${credentials.username}`);

        // GitHub repository details
        const GITHUB_OWNER = 'crendy22';
        const GITHUB_REPO = 'llpa-rate-comparator';
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

        if (!GITHUB_TOKEN) {
            throw new Error('GitHub token not configured in environment variables');
        }

        // Step 1: Trigger GitHub Actions workflow
        console.log('Step 1: Triggering GitHub Actions workflow...');
        const dispatchResponse = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                event_type: 'process-loans',
                client_payload: {
                    loan_data: JSON.stringify(loanData),
                    loan_index: loanIndex,
                    credentials: credentials
                }
            })
        });

        if (!dispatchResponse.ok) {
            const errorText = await dispatchResponse.text();
            throw new Error(`GitHub dispatch failed: ${dispatchResponse.status} - ${errorText}`);
        }

        console.log('✅ GitHub Actions workflow triggered successfully');

        // Step 2: Wait and monitor workflow completion
        console.log('Step 2: Monitoring workflow completion...');
        const workflowResult = await monitorWorkflowCompletion(GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN);

        // Step 3: Return comprehensive result
        return res.status(200).json({
            success: true,
            message: 'Workflow completed with monitoring',
            workflowStatus: workflowResult,
            loanIndex: loanIndex,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Backend error:', error);
        
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error',
            workflowStatus: {
                success: false,
                message: 'Backend error occurred',
                details: error.message
            },
            timestamp: new Date().toISOString()
        });
    }
}

// Function to monitor workflow completion and extract results
async function monitorWorkflowCompletion(owner, repo, token, maxAttempts = 40) {
    console.log('Starting workflow monitoring...');
    
    // Wait a moment for workflow to start
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            // Get recent workflow runs
            const runsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=5`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (!runsResponse.ok) {
                console.error(`Failed to get workflow runs: ${runsResponse.status}`);
                continue;
            }

            const runsData = await runsResponse.json();
            
            // Find the most recent run that could be ours
            const cutoffTime = new Date(Date.now() - 120000); // Last 2 minutes
            const recentRuns = runsData.workflow_runs
                .filter(run => {
                    const runTime = new Date(run.created_at);
                    return runTime > cutoffTime;
                })
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            if (recentRuns.length > 0) {
                const latestRun = recentRuns[0];
                console.log(`Monitoring run ${latestRun.id}: ${latestRun.status}/${latestRun.conclusion}`);

                if (latestRun.status === 'completed') {
                    console.log('✅ Workflow completed, analyzing results...');
                    
                    // Get detailed results
                    const detailedResult = await analyzeWorkflowResult(owner, repo, token, latestRun);
                    
                    return {
                        success: detailedResult.success,
                        message: detailedResult.message,
                        details: detailedResult.details,
                        runUrl: latestRun.html_url,
                        conclusion: latestRun.conclusion,
                        completedAt: latestRun.updated_at
                    };
                }
            }

            // Wait before next check
            console.log(`Attempt ${attempt + 1}/${maxAttempts}: Waiting for workflow completion...`);
            await new Promise(resolve => setTimeout(resolve, 8000)); // 8 seconds

        } catch (error) {
            console.error(`Monitoring attempt ${attempt + 1} failed:`, error);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    // Timeout
    console.log('❌ Workflow monitoring timed out');
    return {
        success: false,
        message: 'Workflow monitoring timed out - automation may still be running',
        details: 'Check GitHub Actions manually for completion status',
        runUrl: `https://github.com/${owner}/${repo}/actions`
    };
}

// Function to analyze workflow results and extract meaningful error info
// Function to analyze workflow results and extract meaningful error info
// Simple and reliable success detection
async function analyzeWorkflowResult(owner, repo, token, workflowRun) {
    try {
        // Get logs to check for actual success
        console.log('Analyzing workflow result, fetching logs...');
        
        try {
            const logsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${workflowRun.id}/logs`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (logsResponse.ok) {
                const logs = await logsResponse.text();
                
                // Simple, reliable check - if Submit Lock clicked, the loan is locked!
                if (logs.includes('Submit Lock button clicked successfully')) {
                    console.log('✅ Found "Submit Lock button clicked successfully" - loan is locked!');
                    return {
                        success: true,
                        message: 'Loan successfully processed and locked in LoanNex',
                        details: 'Confirmed: Submit Lock button was clicked successfully'
                    };
                }
                
                // If no submit lock success, extract error details
                console.log('❌ Submit Lock button was not clicked successfully');
                const errorDetails = extractErrorFromLogs(logs);
                
                return {
                    success: false,
                    message: errorDetails.message || 'Loan processing failed',
                    details: errorDetails.details || 'Submit Lock button was not clicked successfully'
                };
            }
        } catch (logError) {
            console.error('Failed to fetch logs:', logError);
        }

        // Fallback to workflow conclusion if we can't get logs
        if (workflowRun.conclusion === 'success') {
            return {
                success: true,
                message: 'Loan successfully processed and locked in LoanNex',
                details: 'Workflow completed successfully'
            };
        }

        // Failed workflow
        return {
            success: false,
            message: 'Loan processing failed during automation',
            details: `Workflow concluded with: ${workflowRun.conclusion}`
        };

    } catch (error) {
        console.error('Error analyzing workflow result:', error);
        return {
            success: false,
            message: 'Failed to analyze workflow results',
            details: error.message
        };
    }
}

// Function to extract meaningful error messages from GitHub Actions logs
function extractErrorFromLogs(logs) {
    console.log('Analyzing logs for error patterns...');
    
    // Enhanced error patterns including Prepay Penalty errors
    const errorPatterns = [
        // Prepay Penalty specific errors
        {
            pattern: /FAILED: Prepay Penalty is required when Occupancy = Investment/,
            message: () => 'Prepay Penalty required for Investment properties',
            details: () => 'Investment occupancy loans must specify a valid Prepay Penalty option (No Penalty, 5 Year, 4 Year, 3 Year, 2 Year, 1 Year).'
        },
        {
            pattern: /ERROR: Invalid Prepay Penalty '([^']+)'/,
            message: (match) => `Invalid Prepay Penalty: "${match[1]}"`,
            details: () => 'Valid Prepay Penalty options: No Penalty, 5 Year, 4 Year, 3 Year, 2 Year, 1 Year'
        },
        {
            pattern: /ERROR: Occupancy is 'Investment' but no Prepay Penalty specified/,
            message: () => 'Missing Prepay Penalty for Investment loan',
            details: () => 'Investment properties require a Prepay Penalty selection. Add the Prepay Penalty column to your Excel file.'
        },
        
        // Investor errors
        {
            pattern: /FAILED: Could not select investor '([^']+)'/,
            message: (match) => `Investor "${match[1]}" not found in LoanNex`,
            details: (match) => `The investor "${match[1]}" could not be selected from the available options. Check if the investor name matches exactly in LoanNex.`
        },
        {
            pattern: /Failed to apply Investor filter/,
            message: () => 'Investor filter could not be applied',
            details: () => 'The investor multiselect dropdown could not be found or operated correctly.'
        },
        
        // Interest Rate errors
        {
            pattern: /Rate ([0-9.]+)% filtered out all available loans/,
            message: (match) => `Interest rate ${match[1]}% filtered out all loans`,
            details: (match) => `The specified interest rate of ${match[1]}% did not match any available loans in the pricing results.`
        },
        {
            pattern: /Failed to apply Interest Rate filter/,
            message: () => 'Interest rate filter could not be applied',
            details: () => 'The interest rate filter field could not be found or filled in the LoanNex interface.'
        },
        
        // Amortizing Type errors
        {
            pattern: /Failed to apply Amortizing Type filter/,
            message: () => 'Amortizing type filter could not be applied',
            details: () => 'The amortizing type dropdown could not be found or the specified option was not available.'
        },
        
        // Lock process errors
        {
            pattern: /Could not click Lock button/,
            message: () => 'No loans available to lock after applying filters',
            details: () => 'After applying the interest rate, investor, and amortizing type filters, no loans remained available for locking. The filters may have been too restrictive.'
        },
        {
            pattern: /Could not find suitable first input field/,
            message: () => 'Lock form could not be filled',
            details: () => 'The borrower information form did not appear or could not be accessed after clicking Lock.'
        },
        {
            pattern: /Could not click Submit Lock button/,
            message: () => 'Lock submission failed',
            details: () => 'The Submit Lock button could not be found or clicked after filling borrower information.'
        },
        
        // Login errors
        {
            pattern: /Login failed for (.+):/,
            message: (match) => `Login failed for user ${match[1]}`,
            details: () => 'Authentication failed. Check username and password credentials.'
        },
        
        // Field filling errors
        {
            pattern: /Error filling fields with conditional prepay/,
            message: () => 'Form field filling failed',
            details: () => 'An error occurred while filling out the loan application form fields.'
        },
        {
            pattern: /Failed to switch to iframe/,
            message: () => 'Could not access LoanNex interface',
            details: () => 'The LoanNex pricing interface could not be accessed. The page structure may have changed.'
        },
        
        // Browser/automation errors
        {
            pattern: /Failed to initialize Chrome driver/,
            message: () => 'Browser automation failed to start',
            details: () => 'The Chrome browser could not be initialized for automation. This is a system error.'
        },
        {
            pattern: /Error clicking Get Price/,
            message: () => 'Pricing calculation failed',
            details: () => 'The Get Price button could not be clicked after filling loan fields.'
        }
    ];

    // Look for specific error patterns
    for (const errorPattern of errorPatterns) {
        const match = logs.match(errorPattern.pattern);
        if (match) {
            console.log('Found specific error pattern:', match[0]);
            return {
                message: errorPattern.message(match),
                details: errorPattern.details(match)
            };
        }
    }

    // Look for any line containing common failure indicators
    const lines = logs.split('\n');
    const errorLine = lines.find(line => 
        line.includes('FAILED:') || 
        line.includes('ERROR:') || 
        line.includes('Could not') ||
        line.includes('Login failed') ||
        line.includes('Error in') ||
        line.includes('Exception:') ||
        line.includes('Traceback')
    );

    if (errorLine) {
        console.log('Found general error line:', errorLine);
        return {
            message: 'Automation encountered an error',
            details: errorLine.trim().replace(/^\d+/, '').trim() // Remove line numbers
        };
    }

    // Default fallback
    console.log('No specific error pattern found in logs');
    return {
        message: 'Loan processing failed',
        details: 'No specific error details could be extracted from the workflow logs'
    };
}
