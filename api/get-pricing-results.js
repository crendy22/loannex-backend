// /api/get-pricing-results.js
// FIXED: Get REAL pricing results from GitHub workflow logs

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

        console.log(`💰 PRICING RESULTS: Checking pricing results since: ${batchStartTime}`);

        // GitHub repository details
        const GITHUB_OWNER = 'crendy22';
        const GITHUB_REPO = 'llpa-rate-comparator';
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

        if (!GITHUB_TOKEN) {
            throw new Error('GitHub token not configured');
        }

        // Get workflows since batch started (with 30-second buffer)
        const cutoffTime = new Date(new Date(batchStartTime).getTime() - 30000);
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
        
        // Filter workflows from this batch - look for pricing workflows
        const batchWorkflows = runsData.workflow_runs
            .filter(run => {
                const runTime = new Date(run.created_at);
                return runTime >= cutoffTime;
            })
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        console.log(`💰 Found ${batchWorkflows.length} workflows since batch start`);

        // Separate completed vs still running
        const completedWorkflows = batchWorkflows.filter(run => run.status === 'completed');
        const runningWorkflows = batchWorkflows.filter(run => run.status !== 'completed');

        console.log(`✅ Completed: ${completedWorkflows.length}, 🔄 Still running: ${runningWorkflows.length}`);

        // Extract REAL pricing data from each completed workflow
        const pricingResults = [];
        for (const workflow of completedWorkflows) {
            try {
                const pricingData = await extractRealPricingData(GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN, workflow);
                if (pricingData) {
                    pricingResults.push(pricingData);
                }
            } catch (error) {
                console.error(`❌ Error extracting pricing from workflow ${workflow.id}:`, error);
                pricingResults.push({
                    workflowId: workflow.id,
                    loanIndex: 'Unknown',
                    borrowerName: 'Unknown',
                    pricingStatus: 'error',
                    errorMessage: 'Failed to extract pricing data',
                    completedAt: workflow.updated_at,
                    githubUrl: workflow.html_url
                });
            }
        }

        // Check if all pricing is complete (no more workflows running)
        const allPricingComplete = runningWorkflows.length === 0;

        console.log(`💰 PRICING SUMMARY: ${pricingResults.length} priced, ${runningWorkflows.length} still processing`);

        return res.status(200).json({
            success: true,
            pricingResults: pricingResults,
            allPricingComplete: allPricingComplete,
            summary: {
                totalPriced: pricingResults.length,
                stillProcessing: runningWorkflows.length,
                successfulPricing: pricingResults.filter(r => r.pricingStatus === 'success').length,
                failedPricing: pricingResults.filter(r => r.pricingStatus === 'error').length
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Pricing results check error:', error);
        
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to check pricing results',
            timestamp: new Date().toISOString()
        });
    }
}

// FIXED: Extract REAL pricing data from GitHub workflow logs
async function extractRealPricingData(owner, repo, token, workflow) {
    try {
        console.log(`💰 REAL EXTRACTION: Analyzing workflow ${workflow.id} for actual pricing data`);
        
        // Get workflow jobs
        const jobsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${workflow.id}/jobs`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!jobsResponse.ok) {
            throw new Error(`Failed to get jobs: ${jobsResponse.status}`);
        }

        const jobsData = await jobsResponse.json();
        console.log(`💰 Found ${jobsData.jobs.length} jobs for workflow ${workflow.id}`);

        // Look for pricing-only job specifically
        const pricingJob = jobsData.jobs.find(job => 
            job.name.toLowerCase().includes('pricing') || 
            job.name.toLowerCase().includes('price')
        );

        if (!pricingJob) {
            throw new Error('No pricing job found in workflow');
        }

        console.log(`💰 Found pricing job: ${pricingJob.name} (${pricingJob.conclusion})`);

        // Get the job logs to extract pricing data
        const logsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/jobs/${pricingJob.id}/logs`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!logsResponse.ok) {
            throw new Error(`Failed to get job logs: ${logsResponse.status}`);
        }

        const logsText = await logsResponse.text();
        console.log(`💰 Retrieved ${logsText.length} characters of log data`);

        // Extract the pricing data from logs
        const pricingData = extractPricingFromLogs(logsText);
        
        if (!pricingData) {
            throw new Error('No pricing data found in logs');
        }

        console.log(`💰 SUCCESS: Extracted real pricing data:`, pricingData);

        // Determine loan index from workflow or job data
        const loanIndex = extractLoanIndexFromJobName(jobsData.jobs) || extractLoanIndexFromWorkflow(workflow);

        // Return the real extracted data
        return {
            workflowId: workflow.id,
            loanIndex: loanIndex,
            borrowerName: pricingData.borrower_name || 'Unknown',
            pricingStatus: pricingData.pricing_status || 'success',
            interestRate: pricingData.best_rate_option?.interest_rate || pricingData.pricing_options?.[0]?.interest_rate,
            rateDescription: pricingData.best_rate_option?.rate_period || pricingData.pricing_options?.[0]?.rate_period,
            pricePoints: pricingData.best_rate_option?.price_points || pricingData.pricing_options?.[0]?.price_points,
            priceCost: pricingData.best_rate_option?.price_cost || pricingData.pricing_options?.[0]?.price_cost,
            productType: pricingData.best_rate_option?.product_type || pricingData.pricing_options?.[0]?.product_type,
            programName: pricingData.best_rate_option?.program_name || pricingData.pricing_options?.[0]?.program_name,
            programDescription: pricingData.best_rate_option?.program_description || pricingData.pricing_options?.[0]?.program_description,
            monthlyPayment: pricingData.best_rate_option?.monthly_payment || pricingData.pricing_options?.[0]?.monthly_payment,
            investor: pricingData.best_rate_option?.program_name || 'Unknown', // Use program name as investor
            loanAmount: pricingData.loan_amount,
            propertyType: pricingData.property_type,
            totalOptions: pricingData.total_options || 0,
            allPricingOptions: pricingData.pricing_options || [],
            errorMessage: pricingData.error_message || null,
            completedAt: workflow.updated_at,
            githubUrl: workflow.html_url,
            extractionMethod: 'real_log_extraction'
        };

    } catch (error) {
        console.error(`💥 Error extracting real pricing from workflow ${workflow.id}:`, error);
        return {
            workflowId: workflow.id,
            loanIndex: 'Unknown',
            borrowerName: 'Unknown',
            pricingStatus: 'error',
            errorMessage: `Real pricing extraction error: ${error.message}`,
            completedAt: workflow.updated_at,
            githubUrl: workflow.html_url,
            extractionMethod: 'error'
        };
    }
}

// Extract pricing data from GitHub Action logs
function extractPricingFromLogs(logsText) {
    try {
        console.log(`💰 PARSING LOGS: Searching for pricing data in logs...`);
        
        // Look for the pricing data output line
        const pricingOutputPattern = /💰 PRICING_DATA_OUTPUT:\s*({.*})/;
        const match = logsText.match(pricingOutputPattern);
        
        if (!match) {
            console.log(`❌ No pricing data pattern found in logs`);
            return null;
        }

        console.log(`💰 Found pricing data line: ${match[0].substring(0, 200)}...`);
        
        // Parse the JSON data
        const jsonString = match[1];
        const pricingData = JSON.parse(jsonString);
        
        console.log(`💰 Successfully parsed pricing JSON:`, {
            status: pricingData.pricing_status,
            borrower: pricingData.borrower_name,
            totalOptions: pricingData.total_options,
            bestRate: pricingData.best_rate_option?.interest_rate
        });
        
        return pricingData;
        
    } catch (error) {
        console.error(`💥 Error parsing pricing from logs:`, error);
        return null;
    }
}

// Helper function to extract loan index from job names
function extractLoanIndexFromJobName(jobs) {
    for (const job of jobs) {
        const patterns = [
            /loan[:\s]*(\d+)/i,
            /process[:\s]*(\d+)/i,
            /price[:\s]*(\d+)/i,
            /\b(\d+)\b/
        ];
        
        for (const pattern of patterns) {
            const match = job.name.match(pattern);
            if (match) {
                return parseInt(match[1]);
            }
        }
    }
    
    return null;
}

// Helper function to extract loan index from workflow data
function extractLoanIndexFromWorkflow(workflow) {
    // Try to extract from workflow name or head commit message
    const sources = [
        workflow.name,
        workflow.display_title,
        workflow.head_commit?.message
    ].filter(Boolean);
    
    for (const source of sources) {
        const patterns = [
            /loan[:\s]*(\d+)/i,
            /process[:\s]*(\d+)/i,
            /price[:\s]*(\d+)/i,
            /\b(\d+)\b/
        ];
        
        for (const pattern of patterns) {
            const match = source.match(pattern);
            if (match) {
                return parseInt(match[1]);
            }
        }
    }
    
    return 'Unknown';
}
