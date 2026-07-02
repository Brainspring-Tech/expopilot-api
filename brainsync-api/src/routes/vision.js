const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { requireAuth } = require('../middleware/auth');

// All vision routes require a logged-in user — this is a paid API call,
// not a public endpoint.
router.use(requireAuth);

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

// POST /api/vision/business-card
// Body: { image: '<base64 string, no data: prefix>', mediaType: 'image/jpeg' }
// Returns: { text: '<raw model response text>' }
//
// The frontend used to call Anthropic directly with an API key embedded in
// the PWA bundle (VITE_ANTHROPIC_API_KEY), which exposed the key to anyone
// who opened dev tools. This route moves that call server-side so the key
// lives only in Render's environment (ANTHROPIC_API_KEY, no VITE_ prefix —
// never exposed to the client build).
router.post('/business-card', async (req, res, next) => {
  try {
    const { image, mediaType } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'image (base64) is required' });
    }

    const response = await axios.post(
      ANTHROPIC_API_URL,
      {
        model: MODEL,
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: 'Extract contact info from this business card. Return only a JSON object with fields: first_name, last_name, email, phone, organization, title. Use empty string for missing fields.' },
          ],
        }],
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    const text = response.data?.content?.[0]?.text || '';
    res.json({ text });
  } catch (err) {
    if (err.response) {
      console.error('[vision] Anthropic API error', err.response.status, err.response.data);
      return res.status(502).json({ error: 'Vision service error — please try again' });
    }
    next(err);
  }
});

module.exports = router;
