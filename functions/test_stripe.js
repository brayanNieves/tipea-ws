const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

async function test() {
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 500 * 100, // 500 DOP
      currency: "dop",
      automatic_payment_methods: { enabled: true },
      metadata: {
        senderUid: "test_uid",
        targetUserId: "test_target",
        amountPesos: 500,
      },
    });
    console.log("Success:", paymentIntent.id);
  } catch(e) {
    console.error("Error:", e.message);
  }
}
test();
