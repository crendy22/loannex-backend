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
            const loanResult = await analyzeWorkflowSimple(workflow, GITHUB_TOKEN);
            if (loanResult) {
                results.push(loanResult);
            }
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

// ENHANCED: Parse actual lock results from workflow logs
async function analyzeWorkflowSimple(workflow, githubToken) {
    console.log(`🔍 Analyzing workflow ${workflow.id} (${workflow.conclusion})`);
    
    try {
        // Get jobs for this workflow
        const jobsResponse = await fetch(workflow.jobs_url, {
            headers: {
                'Authorization': `Bearer ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        if (!jobsResponse.ok) {
            console.log('Failed to get jobs for workflow');
            return getFallbackResult(workflow);
        }
        
        const jobsData = await jobsResponse.json();
        const job = jobsData.jobs[0];
        
        if (!job) {
            console.log('No jobs found in workflow');
            return getFallbackResult(workflow);
        }
        
        // Get logs
        const logsResponse = await fetch(`${job.url}/logs`, {
            headers: {
                'Authorization': `Bearer ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        if (!logsResponse.ok) {
            console.log('Failed to get logs for job');
            return getFallbackResult(workflow);
        }
        
        const logsText = await logsResponse.text();
        
        // Parse the ACTUAL lock result from Python script output
        const lockResultMatch = logsText.match(/🔒 LOCK_RESULT: ({[^}]+})/);
        
        if (lockResultMatch) {
            try {
                const lockResult = JSON.parse(lockResultMatch[1]);
                
                console.log(`✅ Found lock result:`, lockResult);
                
                return {
                    workflowId: workflow.id,
                    loanIndex: 'Unknown', // Would need to parse this separately
                    borrowerName: lockResult.borrower_name,
                    nexId: lockResult.nex_id,
                    nex_id: lockResult.nex_id,
                    locked: lockResult.lock_status === 'success',
                    errorMessage: lockResult.lock_status === 'success' ? null : lockResult.message,
                    completedAt: workflow.updated_at,
                    githubUrl: workflow.html_url,
                    status: 'parsed_from_logs',
                    successPattern: `Lock result: ${lockResult.lock_status}`
                };
                
            } catch (parseError) {
                console.error('Error parsing lock result JSON:', parseError);
            }
        }
        
        // If no lock result found, return fallback
        return getFallbackResult(workflow);
        
    } catch (error) {
        console.error('Error analyzing workflow:', error);
        return getFallbackResult(workflow);
    }
}

// Helper function for fallback results
function getFallbackResult(workflow) {
    const locked = workflow.conclusion === 'success';
    
    return {
        workflowId: workflow.id,
        loanIndex: 'Unknown',
        borrowerName: 'Unknown',
        nexId: null,
        nex_id: null,
        locked: locked,
        errorMessage: locked ? null : 'Could not parse lock result from logs',
        completedAt: workflow.updated_at,
        githubUrl: workflow.html_url,
        status: 'workflow_conclusion_fallback',
        successPattern: locked ? 'Workflow succeeded' : 'Workflow failed'
    };
}
