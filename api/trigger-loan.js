// Enhanced backend API endpoint: /api/trigger-loan.js
// Replace your entire trigger-loan.js file with this code

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

        console.log(`Triggering GitHub Actions for loan ${loanIndex} with user: ${credentials.username}`);

        // GitHub repository details - pointing to where your workflow lives
        const GITHUB_OWNER = 'crendy22';
        const GITHUB_REPO = 'llpa-rate-comparator';  // Where your .yml workflow file is
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Set this in Vercel environment variables

        if (!GITHUB_TOKEN) {
            throw new Error('GitHub token not configured in environment variables - add GITHUB_TOKEN to Vercel settings');
        }

        console.log(`Triggering workflow in ${GITHUB_OWNER}/${GITHUB_REPO}`);

        // Trigger GitHub Actions workflow via repository dispatch
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
            console.error(`GitHub dispatch failed: ${dispatchResponse.status} - ${errorText}`);
            throw new Error(`GitHub dispatch failed: ${dispatchResponse.status} - ${errorText}`);
        }

        console.log('GitHub Actions dispatch successful');

        // Wait a moment for the workflow to start
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Get the workflow run ID by checking recent runs
        const runsResponse = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?per_page=10`, {
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!runsResponse.ok) {
            console.error(`Failed to get workflow runs: ${runsResponse.status}`);
            // Still return success since the dispatch worked
            return res.status(200).json({
                success: true,
                message: 'GitHub Actions workflow triggered successfully',
                workflowRunId: null, // Frontend will handle this gracefully
                loanIndex: loanIndex,
                timestamp: new Date().toISOString(),
                note: 'Workflow started but run ID not available'
            });
        }

        const runsData = await runsResponse.json();
        console.log(`Found ${runsData.workflow_runs.length} recent workflow runs`);

        // Find the most recent workflow run that matches our criteria
        let workflowRunId = null;
        const cutoffTime = new Date(Date.now() - 60000); // Last 1 minute
        
        const recentRuns = runsData.workflow_runs
            .filter(run => {
                const runTime = new Date(run.created_at);
                return runTime > cutoffTime && 
                       (run.event === 'repository_dispatch' || run.status === 'queued' || run.status === 'in_progress');
            })
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        if (recentRuns.length > 0) {
            workflowRunId = recentRuns[0].id;
            console.log(`Found workflow run ID: ${workflowRunId} (status: ${recentRuns[0].status})`);
        } else {
            console.log('No matching workflow run found, workflow may still be starting');
            // Try to find any recent run as fallback
            const anyRecentRuns = runsData.workflow_runs
                .filter(run => {
                    const runTime = new Date(run.created_at);
                    return runTime > cutoffTime;
                })
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            
            if (anyRecentRuns.length > 0) {
                workflowRunId = anyRecentRuns[0].id;
                console.log(`Using most recent run as fallback: ${workflowRunId}`);
            }
        }

        return res.status(200).json({
            success: true,
            message: 'GitHub Actions workflow triggered successfully',
            workflowRunId: workflowRunId,
            loanIndex: loanIndex,
            timestamp: new Date().toISOString(),
            debug: {
                repoUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions`,
                totalRuns: runsData.workflow_runs.length,
                foundRunId: !!workflowRunId
            }
        });

    } catch (error) {
        console.error('Backend error:', error);
        
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error',
            error: process.env.NODE_ENV === 'development' ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
    }
}
