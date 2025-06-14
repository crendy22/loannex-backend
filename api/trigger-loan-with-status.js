// Enhanced backend API: /api/trigger-loan-with-status.js
// Create this as a NEW file alongside your existing trigger-loan.js
// Force deploy fix - [current time]

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
async function analyzeWorkflowResult(owner, repo, token, workflowRun) {
    try {
        // If workflow succeeded, it's a success
        if (workflowRun.conclusion === 'success') {
            return {
                success: true,
                message: 'Loan successfully processed and locked in LoanNex',
                details: 'All automation steps completed successfully'
            };
        }

        // If workflow failed, try to get error details from logs
        console.log('Workflow failed, extracting error details...');
        
        try {
            const logsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${workflowRun.id}/logs`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (logsResponse.ok) {
                const logs = await logsResponse.text();
                const errorDetails = extractErrorFromLogs(logs);
                
                return {
                    success: false,
                    message: errorDetails.message || 'Loan processing failed',
                    details: errorDetails.details || 'Check GitHub Actions logs for more details'
                };
            }
        } catch (logError) {
            console.error('Failed to fetch logs:', logError);
        }

        // Fallback for failed workflow without logs
        return {
            success: false,
            message: 'Loan processing failed during automation',
            details: `Workflow concluded with: ${workflowRun.conclusion}. Check GitHub Actions for details.`
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
    
    // Common error patterns to look for
    const errorPatterns = [
        {
            pattern: /FAILED: Could not select investor '([^']+)'/,
            message: (match) => `Investor "${match[1]}" not found in LoanNex`,
            details: (match) => `The investor "${match[1]}" could not be selected from the available options. Check if the investor name matches exactly in LoanNex.`
        },
        {
            pattern: /Could not click Lock button/,
            message: () => 'No loans available to lock after applying filters',
            details: () => 'After applying the interest rate, investor, and amortizing type filters, no loans remained available for locking. The filters may have been too restrictive.'
        },
        {
            pattern: /Login failed for (.+):/,
            message: (match) => `Login failed for user ${match[1]}`,
            details: () => 'Authentication failed. Check username and password credentials.'
        },
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
        {
            pattern: /Failed to apply Investor filter/,
            message: () => 'Investor filter could not be applied',
            details: () => 'The investor multiselect dropdown could not be found or operated correctly.'
        },
        {
            pattern: /Failed to apply Amortizing Type filter/,
            message: () => 'Amortizing type filter could not be applied',
            details: () => 'The amortizing type dropdown could not be found or the specified option was not available.'
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
        line.includes('Error in')
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
