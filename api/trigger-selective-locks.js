// /api/trigger-selective-locks.js
// UPDATED: Lock only selected loans after pricing review with NexID support

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

        // NEW: Check for NexID in loan data
        const nexId = loanData.nex_id || loanData.nexId || '';
        if (!nexId) {
            console.log(`⚠️ WARNING: No NexID found for loan ${loanIndex + 1}. Loan data:`, Object.keys(loanData));
            // Don't fail completely, but log the issue
        }

        console.log(`🔒 SELECTIVE LOCK: Processing loan ${loanIndex + 1} for user: ${credentials.username}`);
        console.log(`🔒 NexID: ${nexId || 'NOT FOUND'}`);
        console.log(`🔒 Borrower: ${loanData.firstName || loanData['First Name'] || ''} ${loanData.lastName || loanData['Last Name'] || ''}`);

        // GitHub repository details
        const GITHUB_OWNER = 'crendy22';
        const GITHUB_REPO = 'llpa-rate-comparator';
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

        if (!GITHUB_TOKEN) {
            throw new Error('GitHub token not configured in environment variables');
        }

        // NEW: Enhanced loan data with NexID for the automation script
        const enhancedLoanData = {
            ...loanData,
            nex_id: nexId, // Ensure NexID is included with consistent naming
            nexId: nexId,  // Backup naming convention
            // Normalize field names for the automation script
            'First Name': loanData['First Name'] || loanData.firstName || '',
            'Last Name': loanData['Last Name'] || loanData.lastName || '',
            'Loan Amount': loanData['Loan Amount'] || loanData.loanAmount || '',
            // Add any other field normalizations needed
            selective_lock_mode: true, // Flag for the automation script
            pricing_already_done: true // Flag indicating pricing was already completed
        };

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
                event_type: 'selective-lock', // Event type for selective locks
                client_payload: {
                    loan_data: JSON.stringify(enhancedLoanData), // NEW: Enhanced data with NexID
                    loan_index: loanIndex,
                    credentials: credentials,
                    selective_lock: true,
                    user_approved: true,
                    nex_id: nexId, // NEW: Explicit NexID field
                    workflow_type: 'selective-lock', // NEW: Explicit workflow type
                    timestamp: new Date().toISOString()
                }
            })
        });

        if (!dispatchResponse.ok) {
            const errorText = await dispatchResponse.text();
            throw new Error(`GitHub dispatch failed: ${dispatchResponse.status} - ${errorText}`);
        }

        console.log(`✅ Selective lock workflow triggered successfully for loan ${loanIndex + 1} (NexID: ${nexId || 'N/A'})`);

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
            message: nexId ? 
                `Selective lock workflow triggered for NexID: ${nexId}` : 
                'Selective lock workflow triggered (no NexID found)',
            workflowStatus: {
                success: false, // Will be determined later via Check Results
                message: 'Selective lock automation started - workflow is now running',
                details: nexId ? 
                    `User-approved loan lock triggered for NexID: ${nexId}. Use "Check Final Results" for actual lock status.` :
                    'User-approved loan lock triggered (warning: no NexID found). Use "Check Final Results" for actual lock status.',
                runUrl: runUrl,
                conclusion: 'selective_lock_triggered',
                selectiveLock: true,
                nexId: nexId // NEW: Include NexID in response
            },
            loanIndex: loanIndex,
            nexId: nexId, // NEW: Include NexID in response
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
