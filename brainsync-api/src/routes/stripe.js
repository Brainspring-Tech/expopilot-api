const express  = require('express');
const router   = express.Router();
const stripe   = require('../services/stripe');
const { requireAuth } = require('../middleware/auth');

// All routes here require a logged-in user — they act on that user's org.
router.use(requireAuth);

const PRICE_IDS = {
  monthly:     process.env.STRIPE_PRICE_MONTHLY,
  annual:      process.env.STRIPE_PRICE_ANNUAL,
  topup:       process.env.STRIPE_PRICE_TOPUP,
  pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY,
  pro_annual:  process.env.STRIPE_PRICE_PRO_ANNUAL,
};

// Used by /change-tier to find the equivalent price on the other tier at
// the same billing interval — e.g. an org paying monthly on Standard
// upgrades to monthly Pro, not annual Pro.
const TIER_PRICE_MAP = {
  standard: { monthly: PRICE_IDS.monthly,     annual: PRICE_IDS.annual },
  pro:      { monthly: PRICE_IDS.pro_monthly, annual: PRICE_IDS.pro_annual },
};

function intervalForPriceId(priceId) {
  if (priceId === PRICE_IDS.annual || priceId === PRICE_IDS.pro_annual) return 'annual';
  if (priceId === PRICE_IDS.monthly || priceId === PRICE_IDS.pro_monthly) return 'monthly';
  return null;
}

// POST /api/stripe/checkout
// Body: { planType: 'monthly' | 'annual' | 'topup' | 'pro_monthly' | 'pro_annual', redirectTo?: 'billing' | 'login' }
// Returns: { url: '<stripe checkout url>' }
//
// For brand-new subscriptions only — an org with no active subscription
// yet, picking a plan (Standard or Pro) for the first time. An existing
// subscriber moving between tiers uses /change-tier instead, which
// updates their current subscription in place rather than starting a
// second one.
router.post('/checkout', async (req, res, next) => {
  try {
    const { planType, redirectTo } = req.body;
    const priceId = PRICE_IDS[planType];

    if (!priceId) {
      return res.status(400).json({ error: 'planType must be one of: monthly, annual, topup, pro_monthly, pro_annual' });
    }

    const orgId = req.user.organization_id;

    const { data: org, error: orgError } = await req.userClient
      .from('organizations')
      .select('id, name, stripe_customer_id')
      .eq('id', orgId)
      .maybeSingle();

    if (orgError) throw orgError;
    if (!org) return res.status(404).json({ error: 'Organization not found' });

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
    const tier = planType.startsWith('pro_') ? 'pro' : 'standard';

    const successUrl = redirectTo === 'login'
      ? `${process.env.ADMIN_URL}/login?checkout=success&email=${encodeURIComponent(req.user.email)}`
      : `${process.env.ADMIN_URL}/billing?checkout=success`;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: isTopup ? 'payment' : 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: `${process.env.ADMIN_URL}/billing?checkout=cancelled`,
      // tier tells the webhook whether this new subscription is Standard
      // or Pro, so it can set plan_tier + prospect_finder_enabled
      // correctly on checkout.session.completed.
      metadata: { organization_id: orgId, tier },
    });

    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// POST /api/stripe/change-tier
// Body: { toTier: 'standard' | 'pro' }
// Returns: the updated organization row
//
// For an org that ALREADY has an active subscription, changing tiers.
// Swaps the price on their existing subscription item (matching their
// current billing interval — monthly stays monthly, annual stays annual)
// with immediate proration, rather than creating a second subscription.
// If the org has no active subscription yet, this returns an error
// telling the frontend to use /checkout instead — there's nothing to
// "change," they need to subscribe for the first time.
router.post('/change-tier', async (req, res, next) => {
  try {
    const { toTier } = req.body;
    if (!['standard', 'pro'].includes(toTier)) {
      return res.status(400).json({ error: 'toTier must be "standard" or "pro"' });
    }

    const orgId = req.user.organization_id;

    const { data: org, error: orgError } = await req.userClient
      .from('organizations')
      .select('id, stripe_subscription_id, plan_status')
      .eq('id', orgId)
      .maybeSingle();

    if (orgError) throw orgError;
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    if (!org.stripe_subscription_id || org.plan_status !== 'active') {
      return res.status(400).json({
        error: 'No active subscription to change — subscribe to a plan first.',
        code: 'NO_ACTIVE_SUBSCRIPTION',
      });
    }

    const subscription = await stripe.subscriptions.retrieve(org.stripe_subscription_id);
    const currentItem = subscription.items.data[0];
    const currentPriceId = currentItem.price.id;
    const interval = intervalForPriceId(currentPriceId);

    if (!interval) {
      return res.status(500).json({ error: 'Could not determine billing interval for the current subscription' });
    }

    const newPriceId = TIER_PRICE_MAP[toTier][interval];
    if (!newPriceId) {
      return res.status(500).json({ error: `Missing price configuration for ${toTier} ${interval}` });
    }

    await stripe.subscriptions.update(org.stripe_subscription_id, {
      items: [{ id: currentItem.id, price: newPriceId }],
      proration_behavior: 'create_prorations',
    });

    // proration_behavior alone only calculates the prorated amount as a
    // pending line item — it does NOT charge it right away by default,
    // it would otherwise just get folded into whatever invoice comes
    // next (typically their regular renewal). Explicitly creating an
    // invoice here bundles that pending proration and attempts to charge
    // it immediately, matching "charge now, unlock now." If this fails
    // (e.g. card declined), the price change already went through and
    // access is already granted below — the charge will simply be
    // picked up on their next regular invoice instead as a fallback,
    // rather than blocking the unlock on a billing hiccup.
    try {
      await stripe.invoices.create({
        customer: subscription.customer,
        subscription: org.stripe_subscription_id,
        auto_advance: true,
      });
    } catch (invoiceErr) {
      console.error('[change-tier] immediate proration invoice failed, will bill at next renewal instead:', invoiceErr.message);
    }

    // Update immediately rather than waiting on the webhook round-trip,
    // so the person sees the unlock take effect right away. The webhook
    // (customer.subscription.updated) will also fire and re-confirm the
    // same values — harmless, since it's idempotent.
    const { data: updatedOrg, error: updateError } = await req.userClient
      .from('organizations')
      .update({
        plan_tier: toTier,
        prospect_finder_enabled: toTier === 'pro',
      })
      .eq('id', orgId)
      .select()
      .single();

    if (updateError) throw updateError;
    res.json(updatedOrg);
  } catch (err) { next(err); }
});

// POST /api/stripe/portal
// Returns: { url: '<stripe customer portal url>' }
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
