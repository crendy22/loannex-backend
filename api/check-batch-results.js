// ENHANCED: Complete version with proper log parsing and NexID extraction

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

        // Analyze each completed workflow - USE PROPER LOG ANALYSIS
        const results = [];
        for (const workflow of completedWorkflows) {
            try {
                const loanResult = await analyzeWorkflowLogs(GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN, workflow);
                if (loanResult) {
                    results.push(loanResult);
                }
            } catch (error) {
                console.error(`❌ Error analyzing workflow ${workflow.id}:`, error);
                results.push({
                    workflowId: workflow.id,
                    loanIndex: 'Unknown',
                    borrowerName: 'Unknown',
                    nexId: null,
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

// MAIN FUNCTION: Analyze workflow logs to extract all information
async function analyzeWorkflowLogs(owner, repo, token, workflow) {
    try {
        console.log(`🔍 Analyzing workflow ${workflow.id}`);
        
        // Get the logs URL
        const logsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${workflow.id}/logs`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            },
            redirect: 'manual'
        });

        if (logsResponse.status === 302) {
            const logsUrl = logsResponse.headers.get('location');
            
            // Download the logs
            const logsDownload = await fetch(logsUrl);
            const logsBuffer = await logsDownload.arrayBuffer();
            
            // 🔴 ADD THIS DEBUG CODE HERE 🔴
            console.log(`📦 Downloaded ${logsBuffer.byteLength} bytes`);
            
            // Check first few bytes
            const firstBytes = new Uint8Array(logsBuffer.slice(0, 4));
            console.log(`First 4 bytes: ${Array.from(firstBytes).map(b => b.toString(16)).join(' ')}`);
            console.log(`Is ZIP? ${firstBytes[0] === 0x50 && firstBytes[1] === 0x4B ? 'YES' : 'NO'}`);
            // 🔴 END OF DEBUG CODE 🔴
            
            // Convert to text (logs are in zip format, but we'll try to extract readable parts)
            const logsText = new TextDecoder('utf-8', { fatal: false }).decode(logsBuffer);
            
            // Extract loan information from logs
            const loanIndex = extractLoanIndex(logsText, workflow);
            const borrowerName = extractBorrowerName(logsText);
            const nexId = extractNexId(logsText);
            
            // Check for lock success patterns
            let locked = false;
            let errorMessage = null;
            let successPattern = '';
            
            // Check for LOCK_RESULT JSON
            const lockResultMatch = logsText.match(/🔒 LOCK_RESULT: ({.*})/);
            if (lockResultMatch) {
                try {
                    const lockResult = JSON.parse(lockResultMatch[1]);
                    locked = lockResult.lock_status === 'success';
                    errorMessage = lockResult.message || lockResult.failure_reason;
                    successPattern = 'LOCK_RESULT JSON found';
                    console.log(`📊 Found LOCK_RESULT: ${JSON.stringify(lockResult)}`);
                } catch (e) {
                    console.log('Failed to parse LOCK_RESULT JSON');
                }
            }
            
            // Fallback: Check for success patterns
            if (!lockResultMatch) {
                const successPatterns = [
                    { pattern: /SUCCESS: (AUTO-PROCESS|SELECTIVE-LOCK) completed/i, name: 'SUCCESS completed' },
                    { pattern: /Submit Lock button clicked successfully/i, name: 'Submit Lock clicked' },
                    { pattern: /SUCCESS: LOAN LOCKED/i, name: 'LOAN LOCKED' },
                    { pattern: /Lock completed successfully/i, name: 'Lock completed' }
                ];
                
                for (const { pattern, name } of successPatterns) {
                    if (pattern.test(logsText)) {
                        locked = true;
                        successPattern = name;
                        console.log(`✅ Found success pattern: ${name}`);
                        break;
                    }
                }
            }
            
            // Check for failure patterns if not locked
            if (!locked && !errorMessage) {
                const failurePatterns = [
                    { pattern: /FAILED: (AUTO-PROCESS|SELECTIVE-LOCK) processing failed/i, extract: true },
                    { pattern: /Could not find or click Get Price button/i, message: 'Failed to get pricing' },
                    { pattern: /Login failed/i, message: 'Login failed' },
                    { pattern: /No loans available after filtering/i, message: 'No loans available after filtering' },
                    { pattern: /Could not click initial Lock button/i, message: 'Could not click Lock button' },
                    { pattern: /ERROR: (.+)/i, extract: true }
                ];
                
                for (const failure of failurePatterns) {
                    const match = logsText.match(failure.pattern);
                    if (match) {
                        errorMessage = failure.extract && match[1] ? match[1] : failure.message;
                        console.log(`❌ Found failure: ${errorMessage}`);
                        break;
                    }
                }
            }
            
            console.log(`📊 ENHANCED ANALYSIS: loan=${loanIndex}, borrower=${borrowerName}, nexId=${nexId}, locked=${locked}`);
            
            return {
                workflowId: workflow.id,
                loanIndex: loanIndex,
                borrowerName: borrowerName,
                nexId: nexId,  // ADD THIS
                locked: locked,
                errorMessage: errorMessage,
                completedAt: workflow.updated_at,
                githubUrl: workflow.html_url,
                status: 'log_analysis',
                successPattern: successPattern
            };
            
        } else {
            console.log(`❌ Could not get logs URL for workflow ${workflow.id} (status: ${logsResponse.status})`);
            // Fall back to the multi-approach analysis
            return await analyzeWorkflowMultipleWays(owner, repo, token, workflow);
        }
        
    } catch (error) {
        console.error(`Error analyzing workflow ${workflow.id}:`, error);
        // Fall back to the multi-approach analysis
        return await analyzeWorkflowMultipleWays(owner, repo, token, workflow);
    }
}

// Helper function to extract NexID from logs
function extractNexId(logsText) {
    // Multiple patterns to find NexID
    const patterns = [
        /Successfully extracted NexID: ([A-Z0-9-]+)/i,
        /NexID[:\s]+([A-Z0-9-]+)/i,
        /nex_id["\s:]+["']?([A-Z0-9-]+)/i,
        /"nex_id":\s*"([A-Z0-9-]+)"/i
    ];
    
    for (const pattern of patterns) {
        const match = logsText.match(pattern);
        if (match && match[1] && match[1] !== 'null' && match[1] !== 'Not Saved') {
            console.log(`🔍 Found NexID: ${match[1]}`);
            return match[1];
        }
    }
    
    return null;
}

// Helper function to extract loan index
function extractLoanIndex(logsText, workflow) {
    // Try various patterns
    const patterns = [
        /Loan (\d+):/i,
        /loan[_\s]+(\d+)/i,
        /loanIndex["\s:]+(\d+)/i,
        /Triggering[^0-9]+(\d+)[^0-9]+of/i
    ];
    
    for (const pattern of patterns) {
        const match = logsText.match(pattern);
        if (match) {
            return parseInt(match[1]);
        }
    }
    
    // Try to get from workflow if not in logs
    const workflowMatch = workflow.name?.match(/\d+/);
    if (workflowMatch) {
        return parseInt(workflowMatch[0]);
    }
    
    return 'Unknown';
}

// Helper function to extract borrower name
function extractBorrowerName(logsText) {
    const patterns = [
        /Borrower Name[:\s]+([^\n]+)/i,
        /borrower[_\s]+name["\s:]+["']?([^"'\n]+)/i,
        /Processing loan for[:\s]+([^\n]+)/i,
        /Loan to lock:[:\s]+([^-\n]+)/i
    ];
    
    for (const pattern of patterns) {
        const match = logsText.match(pattern);
        if (match && match[1]) {
            return match[1].trim();
        }
    }
    
    return 'Unknown';
}

// FALLBACK: Try multiple approaches if logs aren't available
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
                nexId: null,  // Can't extract from jobs
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
            nexId: null,
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
            nexId: null,
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
