// api/trigger-loan.js
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const { loanData, loanIndex } = req.body;
  
  if (!loanData) {
    return res.status(400).json({ error: 'Loan data is required' });
  }
  
  try {
    // Your GitHub configuration - using environment variables for security
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const GITHUB_OWNER = 'crendy22';
    const GITHUB_REPO = 'llpa-rate-comparator';
    
    if (!GITHUB_TOKEN) {
      return res.status(500).json({ error: 'GitHub token not configured' });
    }
    
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'LoanNex-Automation-Backend'
        },
        body: JSON.stringify({
          event_type: 'process-loans',
          client_payload: {
            loan_data: JSON.stringify(loanData),
            loan_index: loanIndex,
            timestamp: new Date().toISOString()
          }
        })
      }
    );
    
    if (response.ok || response.status === 204) {
      return res.status(200).json({
        success: true,
        message: 'GitHub Actions triggered successfully',
        loanIndex: loanIndex
      });
    } else {
      const errorText = await response.text();
      return res.status(response.status).json({
        success: false,
        message: `GitHub API error: ${response.status}`,
        error: errorText
      });
    }
    
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
}
