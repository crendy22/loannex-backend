// /api/trigger-selective-locks.js
// NEW: Lock only selected loans after pricing review

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
        const { loanData, loanIndex, credentials, isSelectiveLock } = req.body;
        
        if (!loanData || !credentials) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required loan data or credentials' 
            });
        }

        console.log(`🔒 SELECTIVE LOCK: Processing loan ${loanIndex + 1} for user: ${credentials.username} - SELECTED FOR LOCKING`);

        // GitHub repository details
        const GITHUB_OWNER = 'crendy22';
        const GITHUB_REPO = 'llpa-rate-comparator';
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

        if (!GITHUB_TOKEN) {
            throw new Error('GitHub token not configured in environment variables');
        }

        // Trigger GitHub Actions workflow for SELECTIVE LOCKING
        console.log('🔒 Triggering GitHub Actions workflow for selective lock...');
        const dispatchResponse = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                event_type: 'selective-lock', // NEW: Different event type for selective locks
                client_payload: {
                    loan_data: JSON.stringify(loanData),
                    loan_index: loanIndex,
                    credentials: credentials,
                    selective_lock: true, // NEW: Flag for selective lock mode
                    user_approved: true, // NEW: Flag indicating user reviewed and approved
                    timestamp: new Date().toISOString()
                }
            })
        });

        if (!dispatchResponse.ok) {
            const errorText = await dispatchResponse.text();
            throw new Error(`GitHub dispatch failed: ${dispatchResponse.status} - ${errorText}`);
        }

        console.log(`✅ Selective lock workflow triggered successfully for loan ${loanIndex + 1}`);

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
                    console.log(`📋 Found selective lock workflow run: ${recentRun.id}`);
                }
            }
        } catch (runError) {
            console.log('Could not get workflow run ID, using default URL');
        }

        // Return SUCCESS immediately for selective lock mode
        return res.status(200).json({
            success: true,
            message: 'Selective lock workflow triggered successfully',
            workflowStatus: {
                success: false, // Will be determined later via Check Results
                message: 'Selective lock automation started - workflow is now running',
                details: 'User-approved loan lock triggered successfully. Use "Check Final Results" for actual lock status.',
                runUrl: runUrl,
                conclusion: 'selective_lock_triggered',
                selectiveLock: true // NEW: Flag to indicate this is selective lock mode
            },
            loanIndex: loanIndex,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Backend selective lock trigger error:', error);
        
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error',
            workflowStatus: {
                success: false,
                message: 'Failed to trigger selective lock automation',
                details: error.message || 'Unknown error occurred while triggering selective lock workflow',
                runUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions`,
                conclusion: 'error',
                selectiveLock: true
            },
            timestamp: new Date().toISOString()
        });
    }
}
