const express  = require('express');
const router   = express.Router();
const stripe   = require('../services/stripe');
const { requireAuth } = require('../middleware/auth');

// All routes here require a logged-in user — they act on that user's org.
router.use(requireAuth);

const PRICE_IDS = {
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  annual:  process.env.STRIPE_PRICE_ANNUAL,
  topup:   process.env.STRIPE_PRICE_TOPUP,
};

// POST /api/stripe/checkout
// Body: { planType: 'monthly' | 'annual' | 'topup', redirectTo?: 'billing' | 'login' }
// Returns: { url: '<stripe checkout url>' }
//
// Creates a Stripe Checkout Session and returns its URL — the frontend
// just redirects the browser there. Stripe hosts the actual payment form,
// so no card data ever touches our servers.
router.post('/checkout', async (req, res, next) => {
  try {
    const { planType, redirectTo } = req.body;
    const priceId = PRICE_IDS[planType];

    if (!priceId) {
      return res.status(400).json({ error: 'planType must be one of: monthly, annual, topup' });
    }

    const orgId = req.user.organization_id;

    const { data: org, error: orgError } = await req.userClient
      .from('organizations')
      .select('id, name, stripe_customer_id')
      .eq('id', orgId)
      .maybeSingle();

    if (orgError) throw orgError;
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    // Reuse an existing Stripe customer if this org already has one
    // (e.g. buying a top-up after already subscribing), otherwise let
    // Checkout create one — we save the id via the webhook once the
    // session completes, so we don't need to write it here.
    let customerId = org.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name: org.name,
        metadata: { organization_id: orgId },
      });
      customerId = customer.id;
    }

    const isTopup = planType === 'topup';

    // redirectTo === 'login' is for the buy-now-during-signup flow: the
    // caller authenticated with a token obtained just for this one API
    // call and has no real browser session on the admin console's own
    // origin, so it needs to land on /login (with its email pre-filled)
    // rather than /billing, which would otherwise bounce an unauthenticated
    // browser straight back to /login anyway, losing the success context.
    // Default stays /billing — unchanged for the existing "subscribe from
    // an already-logged-in Billing page" flow.
    const successUrl = redirectTo === 'login'
      ? `${process.env.ADMIN_URL}/login?checkout=success&email=${encodeURIComponent(req.user.email)}`
      : `${process.env.ADMIN_URL}/billing?checkout=success`;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: isTopup ? 'payment' : 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: `${process.env.ADMIN_URL}/billing?checkout=cancelled`,
      metadata: { organization_id: orgId },
    });

    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// POST /api/stripe/portal
// Returns: { url: '<stripe customer portal url>' }
//
// Stripe's hosted Customer Portal — lets the customer update their card,
// view invoices, and cancel their subscription, all without any custom
// UI on our side. What's allowed in the portal (e.g. we only allow
// cancel + payment method update, not plan switching since there's only
// one plan) is configured in the Stripe Dashboard, not here.
router.post('/portal', async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;

    const { data: org, error: orgError } = await req.userClient
      .from('organizations')
      .select('stripe_customer_id')
      .eq('id', orgId)
      .maybeSingle();

    if (orgError) throw orgError;
    if (!org?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found for this organization yet' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripe_customer_id,
      return_url: `${process.env.ADMIN_URL}/billing`,
    });

    res.json({ url: session.url });
  } catch (err) { next(err); }
});

module.exports = router;
