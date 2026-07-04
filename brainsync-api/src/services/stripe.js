const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('[stripe] STRIPE_SECRET_KEY is not set — Stripe routes will fail');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = stripe;
