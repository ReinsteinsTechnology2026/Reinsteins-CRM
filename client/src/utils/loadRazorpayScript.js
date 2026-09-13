// Loads Razorpay's official checkout.js on demand -- only the pages
// that actually open a Razorpay checkout ever load it, and it's only
// fetched once (checked via window.Razorpay) no matter how many times
// a Platform Owner opens/closes the checkout modal in one session.
export function loadRazorpayScript() {
  return new Promise((resolve) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export default loadRazorpayScript;
