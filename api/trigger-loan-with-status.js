// Complete /api/trigger-loan-with-status.js
// FIXED: No more 60-second timeout issues
// Returns immediately after triggering, use Check Results for final status

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

        console.log(`🚀 FIXED: Processing loan ${loanIndex + 1} for user: ${credentials.username} - NO TIMEOUT ISSUES`);

        // GitHub repository details
        const GITHUB_OWNER = 'crendy22';
        const GITHUB_REPO = 'llpa-rate-comparator';
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

        if (!GITHUB_TOKEN) {
            throw new Error('GitHub token not configured in environment variables');
        }

        // Step 1: Trigger GitHub Actions workflow (NO WAITING - avoids 60s timeout)
        console.log('🔄 Triggering GitHub Actions workflow...');
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
                    credentials: credentials,
                    timestamp: new Date().toISOString()
                }
            })
        });

        if (!dispatchResponse.ok) {
            const errorText = await dispatchResponse.text();
            throw new Error(`GitHub dispatch failed: ${dispatchResponse.status} - ${errorText}`);
        }

        console.log(`✅ GitHub Actions workflow triggered successfully for loan ${loanIndex + 1}`);

        // Wait a moment to get the workflow run ID
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Try to get the workflow run ID for tracking
        let runUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions`;
        try {
            const runsResponse = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?per_page=5`, {
                headers: {
                    'Authorization': `Bearer ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (runsResponse.ok) {
                const runsData = await runsResponse.json();
                const recentRun = runsData.workflow_runs
                    .filter(run => {
                        const runTime = new Date(run.created_at);
                        const cutoff = new Date(Date.now() - 30000); // Last 30 seconds
                        return runTime > cutoff;
                    })
                    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

                if (recentRun) {
                    runUrl = recentRun.html_url;
                    console.log(`📋 Found workflow run: ${recentRun.id}`);
                }
            }
        } catch (runError) {
            console.log('Could not get workflow run ID, using default URL');
        }

        // Return SUCCESS immediately - no more waiting that causes timeouts
        return res.status(200).json({
            success: true,
            message: 'Workflow triggered successfully',
            workflowStatus: {
                success: false, // Will be determined later via Check Results
                message: 'Automation started - workflow is now running',
                details: 'Loan automation triggered successfully. Use "Check Final Results" in 5-8 minutes for actual lock status.',
                runUrl: runUrl,
                conclusion: 'triggered'
            },
            loanIndex: loanIndex,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Backend trigger error:', error);
        
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error',
            workflowStatus: {
                success: false,
                message: 'Failed to trigger automation',
                details: error.message || 'Unknown error occurred while triggering workflow',
                runUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions`,
                conclusion: 'error'
            },
            timestamp: new Date().toISOString()
        });
    }
}
