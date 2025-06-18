// /api/check-batch-results.js
// Checks completed GitHub Actions workflows and returns business-friendly results

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
        const { batchStartTime } = req.body;
        
        if (!batchStartTime) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing batch start time' 
            });
        }

        console.log(`Checking batch results since: ${batchStartTime}`);

        // GitHub repository details
        const GITHUB_OWNER = 'crendy22';
        const GITHUB_REPO = 'llpa-rate-comparator';
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

        if (!GITHUB_TOKEN) {
            throw new Error('GitHub token not configured');
        }

        // Get workflows since batch started
        const cutoffTime = new Date(batchStartTime);
        const runsResponse = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?per_page=50`, {
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!runsResponse.ok) {
            throw new Error(`Failed to get workflow runs: ${runsResponse.status}`);
        }

        const runsData = await runsResponse.json();
        
        // Filter workflows from this batch
        const batchWorkflows = runsData.workflow_runs
            .filter(run => {
                const runTime = new Date(run.created_at);
                return runTime >= cutoffTime;
            })
            .filter(run => run.status === 'completed') // Only completed workflows
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        console.log(`Found ${batchWorkflows.length} completed workflows since batch start`);

        // Analyze each workflow
        const results = [];
        for (const workflow of batchWorkflows) {
            try {
                const loanResult = await analyzeWorkflowForLoanResult(GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN, workflow);
                if (loanResult) {
                    results.push(loanResult);
                }
            } catch (error) {
                console.error(`Error analyzing workflow ${workflow.id}:`, error);
                // Add failed analysis as a result
                results.push({
                    workflowId: workflow.id,
                    loanIndex: 'Unknown',
                    borrowerName: 'Unknown',
                    locked: false,
                    errorMessage: 'Failed to analyze workflow results',
                    completedAt: workflow.updated_at,
                    githubUrl: workflow.html_url
                });
            }
        }

        // Calculate summary
        const successfulLocks = results.filter(r => r.locked).length;
        const failedLocks = results.filter(r => !r.locked).length;
        const successRate = results.length > 0 ? Math.round((successfulLocks / results.length) * 100) : 0;

        console.log(`Batch results: ${successfulLocks} locked, ${failedLocks} failed`);

        return res.status(200).json({
            success: true,
            summary: {
                totalProcessed: results.length,
                successfulLocks: successfulLocks,
                failedLocks: failedLocks,
                successRate: successRate
            },
            results: results,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Batch results check error:', error);
        
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to check batch results',
            timestamp: new Date().toISOString()
        });
    }
}

// Analyze individual workflow for loan results
async function analyzeWorkflowForLoanResult(owner, repo, token, workflow) {
    try {
        // Get workflow logs
        const logsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${workflow.id}/logs`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!logsResponse.ok) {
            console.log(`Could not fetch logs for workflow ${workflow.id}`);
            return null;
        }

        const logs = await logsResponse.text();
        
        // Extract loan information from logs
        const loanIndex = extractLoanIndex(logs);
        const borrowerName = extractBorrowerName(logs);
        const locked = logs.includes('Submit Lock button clicked successfully');
        const errorMessage = locked ? null : extractMainError(logs);

        return {
            workflowId: workflow.id,
            loanIndex: loanIndex,
            borrowerName: borrowerName,
            locked: locked,
            errorMessage: errorMessage,
            completedAt: workflow.updated_at,
            githubUrl: workflow.html_url
        };

    } catch (error) {
        console.error(`Error analyzing workflow ${workflow.id}:`, error);
        return null;
    }
}

// Extract loan index from logs
function extractLoanIndex(logs) {
    // Look for patterns like "Processing loan 1" or "loan_index: 1"
    const indexMatch = logs.match(/Processing loan (\d+)/i) || 
                      logs.match(/loan_index[:\s]+(\d+)/i) ||
                      logs.match(/loan (\d+)/i);
    
    return indexMatch ? parseInt(indexMatch[1]) : 'Unknown';
}

// Extract borrower name from logs
function extractBorrowerName(logs) {
    // Look for patterns in the automation logs
    const namePatterns = [
        /Set first field value using JavaScript.*?(\w+)/i,
        /First Name[:\s]+(\w+)/i,
        /Processing fields.*?(\w+)/i
    ];
    
    for (const pattern of namePatterns) {
        const match = logs.match(pattern);
        if (match && match[1] && match[1] !== 'doe') {
            return match[1];
        }
    }
    
    // Fallback: try to extract from validation logs
    const validationMatch = logs.match(/Validating loan.*?(\w+)/i);
    if (validationMatch && validationMatch[1]) {
        return validationMatch[1];
    }
    
    return 'Unknown';
}

// Extract main error message from logs
function extractMainError(logs) {
    // Priority order of error patterns
    const errorPatterns = [
        /FAILED: Could not select investor '([^']+)'/i,
        /FAILED: Prepay Penalty is required/i,
        /ERROR: Invalid Prepay Penalty/i,
        /Login failed for (.+):/i,
        /Could not click Lock button/i,
        /Could not find suitable first input field/i,
        /Could not click Submit Lock button/i,
        /Failed to apply Interest Rate filter/i,
        /Failed to apply Investor filter/i,
        /Failed to apply Amortizing Type filter/i
    ];
    
    for (const pattern of errorPatterns) {
        const match = logs.match(pattern);
        if (match) {
            return match[0].replace('FAILED: ', '').replace('ERROR: ', '');
        }
    }
    
    // Look for any FAILED or ERROR lines
    const lines = logs.split('\n');
    const errorLine = lines.find(line => 
        line.includes('FAILED:') || 
        line.includes('ERROR:') || 
        line.includes('Could not')
    );
    
    if (errorLine) {
        return errorLine.trim().replace(/^\d+/, '').replace('FAILED: ', '').replace('ERROR: ', '').trim();
    }
    
    return 'Unknown error - check GitHub Actions logs';
}
