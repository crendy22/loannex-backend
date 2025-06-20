// ENHANCED: Debug version to find why workflows aren't being detected

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
        const cutoffTime = new Date(batchStartTime);
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
        const completedWorkflows = batchWorkflows.filter(run => run.status === 'completed');
        const runningWorkflows = batchWorkflows.filter(run => run.status !== 'completed');

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

        // Analyze each completed workflow - TRY DIFFERENT APPROACHES
        const results = [];
        for (const workflow of completedWorkflows) {
            try {
                const loanResult = await analyzeWorkflowMultipleWays(GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN, workflow);
                if (loanResult) {
                    results.push(loanResult);
                }
            } catch (error) {
                console.error(`❌ Error analyzing workflow ${workflow.id}:`, error);
                results.push({
                    workflowId: workflow.id,
                    loanIndex: 'Unknown',
                    borrowerName: 'Unknown',
                    locked: false,
                    errorMessage: 'Failed to analyze workflow results',
                    completedAt: workflow.updated_at,
                    githubUrl: workflow.html_url,
                    status: 'analysis_failed'
                });
            }
        }

        // Calculate summary
        const successfulLocks = results.filter(r => r.locked).length;
        const failedLocks = results.filter(r => !r.locked).length;
        const successRate = results.length > 0 ? Math.round((successfulLocks / results.length) * 100) : 0;
        const stillProcessing = runningWorkflows.length;

        console.log(`📈 FINAL MULTI-APPROACH: ${successfulLocks} locked, ${failedLocks} failed, ${stillProcessing} still processing`);

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

// TRY MULTIPLE APPROACHES to get the logs
async function analyzeWorkflowMultipleWays(owner, repo, token, workflow) {
    try {
        console.log(`🔍 MULTI-APPROACH: Analyzing workflow ${workflow.id} (${workflow.conclusion})`);
        
        // Approach 1: Try to get jobs instead of logs
        console.log(`🎯 Approach 1: Getting workflow jobs for ${workflow.id}`);
        const jobsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${workflow.id}/jobs`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (jobsResponse.ok) {
            const jobsData = await jobsResponse.json();
            console.log(`📋 Found ${jobsData.jobs.length} jobs for workflow ${workflow.id}`);
            
            // Check if the workflow conclusion indicates success
            let locked = false;
            let successPattern = '';
            let errorMessage = null;
            
            // Simple heuristic: if workflow concluded successfully, likely locked
            if (workflow.conclusion === 'success') {
                locked = true;
                successPattern = 'Workflow completed successfully';
                console.log(`🎯 SUCCESS HEURISTIC: Workflow ${workflow.id} concluded with 'success'`);
            } else {
                // Look at job names/conclusions for clues
                const failedJob = jobsData.jobs.find(job => job.conclusion === 'failure');
                if (failedJob) {
                    errorMessage = `Job "${failedJob.name}" failed`;
                    console.log(`❌ FAILURE HEURISTIC: Job "${failedJob.name}" failed`);
                } else {
                    errorMessage = `Workflow concluded with: ${workflow.conclusion}`;
                }
            }
            
            const loanIndex = extractLoanIndexFromJobName(jobsData.jobs);
            const borrowerName = 'Unknown'; // Can't extract from job data
            
            console.log(`📊 JOB-BASED ANALYSIS: loan=${loanIndex}, locked=${locked}, pattern="${successPattern}"`);

            return {
                workflowId: workflow.id,
                loanIndex: loanIndex,
                borrowerName: borrowerName,
                locked: locked,
                errorMessage: errorMessage,
                completedAt: workflow.updated_at,
                githubUrl: workflow.html_url,
                status: 'job_based_analysis',
                successPattern: successPattern
            };
        }
        
        // Approach 2: Fallback - just use workflow conclusion
        console.log(`🎯 Approach 2: Using workflow conclusion only for ${workflow.id}`);
        
        let locked = workflow.conclusion === 'success';
        let errorMessage = locked ? null : `Workflow failed with conclusion: ${workflow.conclusion}`;
        let successPattern = locked ? 'Workflow concluded successfully' : '';
        
        console.log(`📊 CONCLUSION-BASED ANALYSIS: locked=${locked}, conclusion="${workflow.conclusion}"`);

        return {
            workflowId: workflow.id,
            loanIndex: 'Unknown',
            borrowerName: 'Unknown',
            locked: locked,
            errorMessage: errorMessage,
            completedAt: workflow.updated_at,
            githubUrl: workflow.html_url,
            status: 'conclusion_based',
            successPattern: successPattern
        };

    } catch (error) {
        console.error(`💥 Error in multi-approach analysis for workflow ${workflow.id}:`, error);
        return {
            workflowId: workflow.id,
            loanIndex: 'Unknown',
            borrowerName: 'Unknown',
            locked: false,
            errorMessage: `Analysis error: ${error.message}`,
            completedAt: workflow.updated_at,
            githubUrl: workflow.html_url,
            status: 'analysis_error'
        };
    }
}

// Try to extract loan index from job names
function extractLoanIndexFromJobName(jobs) {
    for (const job of jobs) {
        const patterns = [
            /loan[:\s]*(\d+)/i,
            /process[:\s]*(\d+)/i,
            /\b(\d+)\b/
        ];
        
        for (const pattern of patterns) {
            const match = job.name.match(pattern);
            if (match) {
                return parseInt(match[1]);
            }
        }
    }
    
    return 'Unknown';
}
