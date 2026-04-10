const Stripe = require('stripe'); try { const stripe = new Stripe('sk_test_123'); console.log('success'); } catch(e) { console.error('error', e.message); }
