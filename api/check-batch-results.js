// FIXED: /api/check-batch-results.js with proper log decompression
// GitHub Actions logs are gzip compressed - we need to decompress them!

import { gunzipSync } from 'zlib';

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

        console.log(`🔍 FIXED: Checking batch results with DECOMPRESSION since: ${batchStartTime}`);

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
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        console.log(`📊 Found ${batchWorkflows.length} workflows since batch start`);

        // Separate completed vs still running
        const completedWorkflows = batchWorkflows.filter(run => run.status === 'completed');
        const runningWorkflows = batchWorkflows.filter(run => run.status !== 'completed');

        console.log(`✅ Completed: ${completedWorkflows.length}, 🔄 Still running: ${runningWorkflows.length}`);

        // Analyze each completed workflow with PROPER DECOMPRESSION
        const results = [];
        for (const workflow of completedWorkflows) {
            try {
                const loanResult = await analyzeWorkflowWithDecompression(GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN, workflow);
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

        console.log(`📈 FINAL WITH DECOMPRESSION: ${successfulLocks} locked, ${failedLocks} failed, ${stillProcessing} still processing`);

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

// FIXED: Properly decompress GitHub Actions logs
async function analyzeWorkflowWithDecompression(owner, repo, token, workflow) {
    try {
        console.log(`🔍 DECOMPRESSION: Analyzing workflow ${workflow.id} (${workflow.conclusion})`);
        
        // Get workflow logs as binary data
        const logsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${workflow.id}/logs`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!logsResponse.ok) {
            console.log(`⚠️ Could not fetch logs for workflow ${workflow.id}: ${logsResponse.status}`);
            return {
                workflowId: workflow.id,
                loanIndex: 'Unknown',
                borrowerName: 'Unknown',
                locked: false,
                errorMessage: 'Could not fetch workflow logs',
                completedAt: workflow.updated_at,
                githubUrl: workflow.html_url,
                status: 'log_fetch_failed'
            };
        }

        // Get logs as buffer (binary data)
        const compressedLogs = await logsResponse.arrayBuffer();
        console.log(`📦 Got compressed logs for workflow ${workflow.id}, size: ${compressedLogs.byteLength} bytes`);
        
        try {
            // DECOMPRESS the logs using gzip
            const decompressedLogs = gunzipSync(Buffer.from(compressedLogs));
            const logs = decompressedLogs.toString('utf8');
            
            console.log(`📝 DECOMPRESSED logs for workflow ${workflow.id}, length: ${logs.length} characters`);
            
            // Now we can search the actual text!
            const successPatterns = [
                'Submit Lock button clicked successfully',
                'SUCCESS: Loan processed and locked',
                'Loan lock completed successfully'
            ];
            
            let locked = false;
            let successPattern = '';
            
            for (const pattern of successPatterns) {
                if (logs.includes(pattern)) {
                    locked = true;
                    successPattern = pattern;
                    console.log(`🎯 FOUND SUCCESS PATTERN: "${pattern}"`);
                    break;
                } else {
                    console.log(`❌ Pattern "${pattern}" NOT found in decompressed logs`);
                }
            }
            
            // DEBUG: Show some actual log content
            const lines = logs.split('\n');
            console.log(`📄 Total lines in decompressed log: ${lines.length}`);
            
            // Show last few lines of actual text
            const lastLines = lines.slice(-5).filter(line => line.trim().length > 0);
            console.log(`📋 Last 5 non-empty lines:`);
            lastLines.forEach((line, index) => {
                console.log(`  ${index + 1}: ${line.trim().substring(0, 100)}...`);
            });
            
            const loanIndex = extractLoanIndex(logs);
            const borrowerName = extractBorrowerName(logs);
            const errorMessage = locked ? null : extractMainError(logs);

            console.log(`📊 DECOMPRESSED ANALYSIS: loan=${loanIndex}, borrower=${borrowerName}, locked=${locked}, pattern="${successPattern}"`);

            return {
                workflowId: workflow.id,
                loanIndex: loanIndex,
                borrowerName: borrowerName,
                locked: locked,
                errorMessage: errorMessage,
                completedAt: workflow.updated_at,
                githubUrl: workflow.html_url,
                status: 'analyzed',
                successPattern: successPattern
            };

        } catch (decompressionError) {
            console.error(`💥 Failed to decompress logs for workflow ${workflow.id}:`, decompressionError);
            return {
                workflowId: workflow.id,
                loanIndex: 'Unknown',
                borrowerName: 'Unknown',
                locked: false,
                errorMessage: `Failed to decompress logs: ${decompressionError.message}`,
                completedAt: workflow.updated_at,
                githubUrl: workflow.html_url,
                status: 'decompression_failed'
            };
        }

    } catch (error) {
        console.error(`💥 Error analyzing workflow ${workflow.id}:`, error);
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

// Extract loan index from logs
function extractLoanIndex(logs) {
    const patterns = [
        /Processing loan (\d+)/i,
        /loan_index[:\s]+(\d+)/i,
        /loan (\d+)/i,
        /Loan #(\d+)/i
    ];
    
    for (const pattern of patterns) {
        const match = logs.match(pattern);
        if (match) {
            return parseInt(match[1]);
        }
    }
    
    return 'Unknown';
}

// Extract borrower name from logs  
function extractBorrowerName(logs) {
    const patterns = [
        /Set first field value.*?'([^']+)'/i,
        /First Name[:\s]+([A-Za-z]+)/i,
        /filled.*?first.*?name.*?'([^']+)'/i,
        /borrower.*?name[:\s]+([A-Za-z]+)/i
    ];
    
    for (const pattern of patterns) {
        const match = logs.match(pattern);
        if (match && match[1] && match[1] !== 'doe' && match[1] !== 'Investment' && match[1].length > 1) {
            return match[1];
        }
    }
    
    return 'Unknown';
}

// Extract main error message from logs
function extractMainError(logs) {
    const errorPatterns = [
        { pattern: /FAILED: Prepay Penalty is required when Occupancy = Investment/i, message: 'Prepay Penalty required for Investment properties' },
        { pattern: /ERROR: Invalid Prepay Penalty '([^']+)'/i, message: (m) => `Invalid Prepay Penalty: "${m[1]}"` },
        { pattern: /FAILED: Could not select investor '([^']+)'/i, message: (m) => `Investor "${m[1]}" not found in LoanNex` },
        { pattern: /Failed to apply Investor filter/i, message: 'Investor filter could not be applied' },
        { pattern: /Rate ([0-9.]+)% filtered out all available loans/i, message: (m) => `Interest rate ${m[1]}% filtered out all loans` },
        { pattern: /Could not click Lock button/i, message: 'No loans available to lock after applying filters' },
        { pattern: /Could not click Submit Lock button/i, message: 'Lock submission failed' },
        { pattern: /Login failed for (.+):/i, message: (m) => `Login failed for user ${m[1]}` },
        { pattern: /FAILED:/i, message: 'Automation process failed' },
        { pattern: /ERROR:/i, message: 'Error occurred during processing' }
    ];
    
    for (const errorPattern of errorPatterns) {
        const match = logs.match(errorPattern.pattern);
        if (match) {
            if (typeof errorPattern.message === 'function') {
                return errorPattern.message(match);
            } else {
                return errorPattern.message;
            }
        }
    }
    
    const lines = logs.split('\n');
    const errorLine = lines.find(line => 
        (line.includes('FAILED:') || line.includes('ERROR:') || line.includes('Could not')) &&
        !line.includes('DEBUG') && !line.includes('INFO')
    );
    
    if (errorLine) {
        return errorLine.replace(/^\d+\s*/, '').replace(/^(FAILED:|ERROR:)\s*/, '').trim();
    }
    
    return 'Unknown error - check GitHub Actions logs for details';
}
