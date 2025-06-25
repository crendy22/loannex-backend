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
            
            console.log(`📦 Downloaded ${logsBuffer.byteLength} bytes`);
            
            // Try multiple encodings to extract text from the ZIP
            let rawData = '';
            
            // Method 1: Try UTF-8
            try {
                rawData = Buffer.from(logsBuffer).toString('utf8');
            } catch (e) {
                console.log('UTF-8 conversion failed, trying latin1');
                rawData = Buffer.from(logsBuffer).toString('latin1');
            }
            
            console.log(`📄 Converted to string: ${rawData.length} characters`);
            
            // DEBUG: Check if we can find key patterns
            const hasSuccess = rawData.includes('SUCCESS');
            const hasLocked = rawData.includes('locked') || rawData.includes('LOCKED');
            const hasFailed = rawData.includes('FAILED') || rawData.includes('ERROR');
            console.log(`🔍 Pattern check - SUCCESS: ${hasSuccess}, LOCKED: ${hasLocked}, FAILED: ${hasFailed}`);
            
            // If we find evidence of text patterns, search more thoroughly
            if (hasSuccess || hasLocked) {
                // Find all occurrences of SUCCESS
                let searchIndex = 0;
                while ((searchIndex = rawData.indexOf('SUCCESS', searchIndex)) !== -1) {
                    const context = rawData.substring(
                        Math.max(0, searchIndex - 50), 
                        Math.min(rawData.length, searchIndex + 150)
                    ).replace(/[^\x20-\x7E\n]/g, ' ');
                    console.log(`📝 SUCCESS context at ${searchIndex}: "${context}"`);
                    searchIndex += 1;
                }
            }
        
            // Look for our success indicators directly
            let locked = false;
            let nexId = null;
            let borrowerName = 'Unknown';
            let errorMessage = null;
            
            // Search for LOCK_RESULT JSON
            if (rawData.includes('LOCK_RESULT')) {
                const match = rawData.match(/LOCK_RESULT[^{]*({[^}]+})/);
                if (match) {
                    try {
                        const lockResult = JSON.parse(match[1]);
                        locked = lockResult.lock_status === 'success';
                        nexId = lockResult.nex_id || lockResult.nexId;
                        borrowerName = lockResult.borrower_name || 'Unknown';
                        errorMessage = lockResult.message || lockResult.failure_reason;
                        console.log(`✅ Found LOCK_RESULT: ${JSON.stringify(lockResult)}`);
                    } catch (e) {
                        console.log('Found LOCK_RESULT but could not parse');
                    }
                }
            }
            
            // Fallback: Look for SUCCESS pattern
            if (!locked && rawData.includes('SUCCESS: SELECTIVE-LOCK completed')) {
                locked = true;
                console.log('✅ Found SELECTIVE-LOCK SUCCESS pattern');
            }
            
            // Check for AUTO-PROCESS success - more lenient patterns
            if (!locked) {
                // Try exact match first
                const autoProcessMatch = rawData.match(/SUCCESS:\s*AUTO-PROCESS\s+(?:loan\s+)?(?:locked|completed)/i);
                if (autoProcessMatch) {
                    locked = true;
                    console.log(`✅ Found AUTO-PROCESS SUCCESS pattern: "${autoProcessMatch[0]}"`);
                } else {
                    // Try finding the components separately (ZIP might have garbled the exact string)
                    const hasAutoProcess = rawData.includes('AUTO-PROCESS') || rawData.includes('AUTO PROCESS');
                    const hasSuccessNearby = rawData.includes('SUCCESS');
                    const hasLockedNearby = rawData.includes('locked') || rawData.includes('LOCKED');
                    
                    if (hasAutoProcess && hasSuccessNearby && hasLockedNearby) {
                        // Find positions to verify they're near each other
                        const autoPos = rawData.indexOf('AUTO-PROCESS') !== -1 ? rawData.indexOf('AUTO-PROCESS') : rawData.indexOf('AUTO PROCESS');
                        const successPos = rawData.indexOf('SUCCESS');
                        
                        if (autoPos !== -1 && successPos !== -1 && Math.abs(autoPos - successPos) < 100) {
                            locked = true;
                            console.log('✅ Found AUTO-PROCESS SUCCESS pattern (proximity match)');
                        }
                    }
                }
            }
            
            // Check for failure patterns
            if (!locked && (rawData.includes('FAILED') || rawData.includes('ERROR'))) {
                const failurePatterns = [
                    /FAILED:\s*AUTO-PROCESS/i,
                    /ERROR:\s*(?:Failed to lock|Lock failed)/i,
                    /Lock Status:\s*Failed/i,
                    /FAILURE:\s*(?:AUTO-PROCESS|SELECTIVE-LOCK)/i
                ];
                
                for (const pattern of failurePatterns) {
                    const match = rawData.match(pattern);
                    if (match) {
                        errorMessage = match[0];
                        console.log(`❌ Found failure pattern: "${match[0]}"`);
                        break;
                    }
                }
            }
            
            // Try to extract loan index from patterns in the data
            let loanIndex = 'Unknown';
            const loanIndexMatch = rawData.match(/Loan (\d+):/i) || rawData.match(/loan[_\s]+(\d+)/i);
            if (loanIndexMatch) {
                loanIndex = parseInt(loanIndexMatch[1]);
            }
            
            // If we still don't have borrower name, try to extract it
            if (borrowerName === 'Unknown') {
                const borrowerMatch = rawData.match(/(?:Loan to lock|Processing loan for|Borrower):[:\s]+([^-\n]+)/i);
                if (borrowerMatch) {
                    borrowerName = borrowerMatch[1].trim();
                }
            }
            
            console.log(`📊 FINAL: locked=${locked}, nexId=${nexId}, borrower=${borrowerName}, loanIndex=${loanIndex}`);
            
            // IMPORTANT: Only trust the log parsing if we found clear evidence
            if (!locked && !errorMessage && !hasSuccess && !hasFailed) {
                console.log('⚠️ No clear success/failure patterns found - falling back to workflow analysis');
                return await analyzeWorkflowMultipleWays(owner, repo, token, workflow);
            }
            
            return {
                workflowId: workflow.id,
                loanIndex: loanIndex,
                borrowerName: borrowerName,
                nexId: nexId,
                nex_id: nexId,  // Include both formats
                locked: locked,
                errorMessage: errorMessage,
                completedAt: workflow.updated_at,
                githubUrl: workflow.html_url,
                status: 'pattern_search',
                successPattern: locked ? 'Pattern found in logs' : 'No success pattern found'
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

// FALLBACK: Try multiple approaches if logs aren't available
async function analyzeWorkflowMultipleWays(owner, repo, token, workflow) {
    try {
        console.log(`🔍 MULTI-APPROACH: Analyzing workflow ${workflow.id} (${workflow.conclusion})`);
        
        // IMPORTANT: When we can't read logs, we should be conservative
        // A successful workflow doesn't always mean the loan was locked
        
        // Default to NOT locked unless we have strong evidence
        let locked = false;
        let errorMessage = 'Could not determine lock status from logs';
        let successPattern = '';
        
        // Only if workflow failed can we be confident the loan didn't lock
        if (workflow.conclusion === 'failure') {
            locked = false;
            errorMessage = 'Workflow failed';
            successPattern = 'Workflow failure indicates lock failed';
            console.log(`❌ Workflow ${workflow.id} failed - loan not locked`);
        } else if (workflow.conclusion === 'success') {
            // For successful workflows, we can't be sure without logs
            // So we mark it as unknown/indeterminate
            console.log(`⚠️ Workflow ${workflow.id} succeeded but can't verify lock status without logs`);
            errorMessage = 'Workflow succeeded but lock status unknown (logs unreadable)';
        }
        
        return {
            workflowId: workflow.id,
            loanIndex: 'Unknown',
            borrowerName: 'Unknown',
            nexId: null,
            locked: locked,
            errorMessage: errorMessage,
            completedAt: workflow.updated_at,
            githubUrl: workflow.html_url,
            status: 'workflow_conclusion_only',
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
