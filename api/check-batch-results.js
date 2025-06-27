// SIMPLIFIED: Check GitHub Actions workflow conclusion for lock status

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

        console.log(`🔍 DEBUG: Checking batch results since: ${batchStartTime}`);

        // GitHub repository details
        const GITHUB_OWNER = 'crendy22';
        const GITHUB_REPO = 'llpa-rate-comparator';
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

        if (!GITHUB_TOKEN) {
            throw new Error('GitHub token not configured');
        }

        // Get workflows since batch started
        const cutoffTime = new Date(new Date(batchStartTime).getTime() - 30000); // 30 seconds buffer
        console.log(`🔍 DEBUG: Cutoff time: ${cutoffTime.toISOString()}`);
        console.log(`🔍 DEBUG: Current time: ${new Date().toISOString()}`);

        const runsResponse = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?per_page=50`, {
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!runsResponse.ok) {
            const errorText = await runsResponse.text();
            console.error(`❌ GitHub API Error: ${runsResponse.status} - ${errorText}`);
            throw new Error(`Failed to get workflow runs: ${runsResponse.status} - ${errorText}`);
        }

        const runsData = await runsResponse.json();
        console.log(`🔍 DEBUG: Total workflows found: ${runsData.workflow_runs.length}`);
        
        // Show first 3 workflows with detailed time comparison
        console.log('🔍 DEBUG: Recent workflows:');
        runsData.workflow_runs.slice(0, 3).forEach((run, index) => {
            const runTime = new Date(run.created_at);
            const timeDiffMinutes = (runTime - cutoffTime) / 1000 / 60;
            const isAfterCutoff = runTime >= cutoffTime;
            console.log(`  ${index + 1}. ID: ${run.id}`);
            console.log(`     Created: ${run.created_at}`);
            console.log(`     Time diff: ${timeDiffMinutes.toFixed(2)} minutes from cutoff`);
            console.log(`     Status: ${run.status}, Conclusion: ${run.conclusion}`);
            console.log(`     After cutoff: ${isAfterCutoff}`);
            console.log(`     Event: ${run.event}`);
        });
        
        // Filter workflows from this batch
        const batchWorkflows = runsData.workflow_runs
            .filter(run => {
                const runTime = new Date(run.created_at);
                return runTime >= cutoffTime;
            })
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        console.log(`📊 Found ${batchWorkflows.length} workflows since batch start`);

        // Separate completed vs still running
        // IMPORTANT: Only consider workflows completed if they have a conclusion
        const completedWorkflows = batchWorkflows.filter(run => 
            run.status === 'completed' && run.conclusion !== null
        );
        const runningWorkflows = batchWorkflows.filter(run => 
            run.status !== 'completed' || run.conclusion === null
        );

        console.log(`✅ Completed: ${completedWorkflows.length}, 🔄 Still running: ${runningWorkflows.length}`);

        // Show details of what we found
        if (batchWorkflows.length === 0) {
            console.log('❌ NO WORKFLOWS FOUND - Time filtering excluded everything');
        } else {
            console.log('📋 Batch workflows details:');
            batchWorkflows.forEach(run => {
                console.log(`  - ${run.id}: ${run.created_at} (${run.status})`);
            });
        }

        // Analyze each completed workflow
        const results = [];
        for (const workflow of completedWorkflows) {
            const loanResult = analyzeWorkflowSimple(workflow);
            results.push(loanResult);
        }

        // Calculate summary
        const successfulLocks = results.filter(r => r.locked).length;
        const failedLocks = results.filter(r => !r.locked).length;
        const successRate = results.length > 0 ? Math.round((successfulLocks / results.length) * 100) : 0;
        const stillProcessing = runningWorkflows.length;

        console.log(`📈 FINAL RESULTS: ${successfulLocks} locked, ${failedLocks} failed, ${stillProcessing} still processing`);

        return res.status(200).json({
            success: true,
            summary: {
                totalProcessed: results.length,
                successfulLocks: successfulLocks,
                failedLocks: failedLocks,
                successRate: successRate,
                stillProcessing: stillProcessing,
                isComplete: stillProcessing === 0
            },
            results: results,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Batch results check error:', error);
        
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to check batch results',
            timestamp: new Date().toISOString()
        });
    }
}

// SIMPLIFIED: Just check workflow conclusion
function analyzeWorkflowSimple(workflow) {
    console.log(`🔍 Analyzing workflow ${workflow.id} (${workflow.conclusion})`);
    
    // Simple approach: GitHub Actions workflow conclusion tells us if the loan locked
    // If workflow succeeded = loan locked
    // If workflow failed = loan didn't lock
    const locked = workflow.conclusion === 'success';
    
    console.log(`📊 Workflow ${workflow.id}: conclusion = ${workflow.conclusion}, locked = ${locked}`);
    
    // Try to extract loan index from workflow name if available
    let loanIndex = 'Unknown';
    const workflowMatch = workflow.name?.match(/\d+/);
    if (workflowMatch) {
        loanIndex = parseInt(workflowMatch[0]);
    }
    
    return {
        workflowId: workflow.id,
        loanIndex: loanIndex,
        borrowerName: 'Unknown',
        nexId: null,
        nex_id: null,
        locked: locked,
        errorMessage: locked ? null : 'Loan failed to lock',
        completedAt: workflow.updated_at,
        githubUrl: workflow.html_url,
        status: 'workflow_conclusion',
        successPattern: locked ? 'Workflow succeeded' : 'Workflow failed'
    };
}
