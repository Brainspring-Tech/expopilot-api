const express  = require('express');
const router   = express.Router();
const stripe   = require('../services/stripe');
const supabase = require('../services/supabase'); // service-role client — no
                                                    // logged-in user exists
                                                    // when Stripe calls this

const TOPUP_SCANS_GRANTED = 100;

const PRO_PRICE_IDS = [process.env.STRIPE_PRICE_PRO_MONTHLY, process.env.STRIPE_PRICE_PRO_ANNUAL];

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

// Inspects a Stripe subscription's current price to determine which tier
// it represents. Used on customer.subscription.updated so a tier change
// made any way (our /change-tier endpoint, or manually in the Stripe
// dashboard) ends up reflected in plan_tier/prospect_finder_enabled.
function tierForSubscription(subscription) {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  return PRO_PRICE_IDS.includes(priceId) ? 'pro' : 'standard';
}

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
        const tier = session.metadata?.tier === 'pro' ? 'pro' : 'standard';

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
              plan_tier: tier,
              prospect_finder_enabled: tier === 'pro',
            })
            .eq('id', orgId);

          if (error) console.error('[stripe webhook] failed to update org after subscription checkout:', error.message);
        } else if (session.mode === 'payment') {
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
        const tier = tierForSubscription(subscription);

        const { error } = await supabase
          .from('organizations')
          .update({
            plan_status: mapSubscriptionStatus(subscription.status),
            plan_tier: tier,
            prospect_finder_enabled: tier === 'pro',
          })
          .eq('stripe_subscription_id', subscription.id);

        if (error) console.error('[stripe webhook] failed to update org on subscription update:', error.message);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const { error } = await supabase
          .from('organizations')
          .update({
            plan_status: 'canceled',
            plan_tier: 'standard',
            prospect_finder_enabled: false,
          })
          .eq('stripe_subscription_id', subscription.id);

        if (error) console.error('[stripe webhook] failed to update org on subscription deletion:', error.message);
        break;
      }

      // Previously unhandled entirely — a failed card produced no record
      // anywhere until the subscription eventually flipped to past_due
      // days into Stripe's dunning retries. payment_failure_count lets
      // the platform-operator console flag "N failed attempts, most
      // recent on <date>" well before that happens.
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const { data: org, error: fetchError } = await supabase
          .from('organizations')
          .select('id, payment_failure_count')
          .eq('stripe_customer_id', invoice.customer)
          .maybeSingle();

        if (fetchError) {
          console.error('[stripe webhook] failed to look up org for payment_failed:', fetchError.message);
          break;
        }
        if (!org) {
          console.error('[stripe webhook] invoice.payment_failed for unknown stripe_customer_id', invoice.customer);
          break;
        }

        const { error } = await supabase
          .from('organizations')
          .update({
            last_payment_failed_at: new Date().toISOString(),
            payment_failure_count: (org.payment_failure_count || 0) + 1,
          })
          .eq('id', org.id);

        if (error) console.error('[stripe webhook] failed to record payment failure:', error.message);
        break;
      }

      // Clears the streak once a retry succeeds — payment_failure_count
      // is meant to reflect an unresolved problem right now, not a
      // lifetime failure tally.
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const { error } = await supabase
          .from('organizations')
          .update({ payment_failure_count: 0 })
          .eq('stripe_customer_id', invoice.customer);

        if (error) console.error('[stripe webhook] failed to clear payment failure count:', error.message);
        break;
      }

      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[stripe webhook] unhandled error processing event:', event.type, err.message);
    res.status(500).json({ error: 'Webhook handler error' });
  }
});

module.exports = router;
