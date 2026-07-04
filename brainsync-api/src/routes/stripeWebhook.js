const express  = require('express');
const router   = express.Router();
const stripe   = require('../services/stripe');
const supabase = require('../services/supabase'); // service-role client — no
                                                    // logged-in user exists
                                                    // when Stripe calls this

// How many scans a single top-up purchase grants. If this ever needs to
// vary (e.g. multiple top-up sizes), read it from the session's line
// items instead of hardcoding — fine as a constant while there's one
// top-up price.
const TOPUP_SCANS_GRANTED = 100;

// Maps a Stripe subscription status to our own plan_status values.
// Stripe has more granular statuses (trialing, incomplete, incomplete_expired,
// past_due, canceled, unpaid, paused) than we currently act on — anything
// not explicitly listed here falls through to 'past_due' as a safe default
// rather than silently leaving an org in a stale state.
function mapSubscriptionStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'past_due';
  }
}

// POST /api/stripe/webhook
// Mounted BEFORE express.json() in index.js — Stripe's signature
// verification needs the raw, unparsed request body. If this route ever
// sees a parsed body instead of a Buffer, signature verification will
// fail with a cryptic error, so double check mounting order first if
// this route starts rejecting everything.
router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const orgId = session.metadata?.organization_id;

        if (!orgId) {
          console.error('[stripe webhook] checkout.session.completed with no organization_id metadata', session.id);
          break;
        }

        if (session.mode === 'subscription') {
          const { error } = await supabase
            .from('organizations')
            .update({
              stripe_customer_id: session.customer,
              stripe_subscription_id: session.subscription,
              plan_status: 'active',
            })
            .eq('id', orgId);

          if (error) console.error('[stripe webhook] failed to update org after subscription checkout:', error.message);
        } else if (session.mode === 'payment') {
          // Top-up purchase — grant scans for the current month via the
          // same ledger pattern vision_usage already uses, rather than
          // permanently raising the org's base limit.
          const { error } = await supabase
            .from('vision_topups')
            .insert({
              organization_id: orgId,
              scans_granted: TOPUP_SCANS_GRANTED,
              stripe_payment_intent_id: session.payment_intent,
            });

          if (error) console.error('[stripe webhook] failed to record vision topup:', error.message);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const { error } = await supabase
          .from('organizations')
          .update({ plan_status: mapSubscriptionStatus(subscription.status) })
          .eq('stripe_subscription_id', subscription.id);

        if (error) console.error('[stripe webhook] failed to update org on subscription update:', error.message);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const { error } = await supabase
          .from('organizations')
          .update({ plan_status: 'canceled' })
          .eq('stripe_subscription_id', subscription.id);

        if (error) console.error('[stripe webhook] failed to update org on subscription deletion:', error.message);
        break;
      }

      default:
        // Unhandled event types are fine to ignore — Stripe sends many
        // more event types than we act on.
        break;
    }

    // Always 200 once signature is verified and we've attempted handling,
    // even if a downstream Supabase update logged an error above —
    // returning a non-200 here just makes Stripe retry the same event,
    // which won't fix a real bug and will spam logs.
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe webhook] unhandled error processing event:', event.type, err.message);
    res.status(500).json({ error: 'Webhook handler error' });
  }
});

module.exports = router;
