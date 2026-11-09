(function () {
  "use strict";
  var id = new URLSearchParams(location.search).get("id") || "";
  var endpoint = "/api/payments/checkout/" + encodeURIComponent(id);
  var status = document.getElementById("vq-checkout-status");
  var paymentStatus = document.getElementById("vq-payment-status");
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]; }); }
  function setMessage(target, message, bad) { target.textContent = message; target.classList.toggle("is-error", !!bad); }
  async function post(path, body) {
    var response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "accept": "application/json" }, body: JSON.stringify(body || {}) });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok || !data.ok) throw new Error(data.message || data.error || "Payment request failed.");
    return data;
  }
  function loadPaypal(clientId, mode) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = "https://www.paypal.com/sdk/js?client-id=" + encodeURIComponent(clientId) + "&currency=USD&intent=capture" + (mode === "sandbox" ? "&buyer-country=US" : "");
      script.async = true; script.onload = resolve; script.onerror = function () { reject(new Error("PayPal checkout could not load.")); };
      document.head.appendChild(script);
    });
  }
  async function init() {
    if (!/^[a-f0-9-]{36}$/i.test(id)) { setMessage(status, "This checkout link is invalid or incomplete.", true); return; }
    try {
      var response = await fetch(endpoint, { headers: { "accept": "application/json" } });
      var data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || data.error || "Checkout could not be loaded.");
      var order = data.checkout || {};
      document.getElementById("vq-order-items").innerHTML = (order.items || []).map(function (item) {
        return "<li><span>" + Number(item.quantity) + " × " + esc(item.name) + "</span><strong>$" + (Number(item.unit_amount_usd) * Number(item.quantity)).toFixed(2) + "</strong></li>";
      }).join("");
      document.getElementById("vq-order-total").textContent = "$" + Number(order.amount_usd).toFixed(2);
      document.getElementById("vq-order-expiry").textContent = order.expires_at ? "Checkout expires " + new Date(order.expires_at).toLocaleString() + "." : "";
      document.getElementById("vq-checkout-root").hidden = false;
      if (order.status === "paid") { setMessage(status, "Payment received. The merchant's order is being processed."); return; }
      setMessage(status, "Order ready. Choose a payment method below.");
      if (data.methods && data.methods.paypal && data.paypal && data.paypal.client_id) {
        document.getElementById("vq-paypal-wrap").hidden = false;
        try {
          await loadPaypal(data.paypal.client_id, data.paypal.mode);
          window.paypal.Buttons({
            createOrder: async function () {
              setMessage(paymentStatus, "Connecting to PayPal…");
              var created = await post(endpoint + "/paypal/create-order");
              return created.order_id;
            },
            onApprove: async function (details) {
              setMessage(paymentStatus, "Confirming your payment…");
              var captured = await post(endpoint + "/paypal/capture", { order_id: details.orderID });
              setMessage(paymentStatus, captured.status === "paid" ? "Payment received. Your merchant's order is confirmed." : "Payment status: " + captured.status);
              document.getElementById("vq-paypal-buttons").hidden = true;
              document.getElementById("vq-crypto-wrap").hidden = true;
            },
            onError: function () { setMessage(paymentStatus, "PayPal could not complete the payment. Try again or contact the merchant.", true); }
          }).render("#vq-paypal-buttons");
        } catch (error) { setMessage(paymentStatus, error.message, true); }
      }
      if (data.methods && data.methods.crypto && data.wallet_address) {
        document.getElementById("vq-crypto-wrap").hidden = false;
        document.getElementById("vq-wallet").textContent = data.wallet_address;
        document.getElementById("vq-copy-wallet").addEventListener("click", async function () {
          try { await navigator.clipboard.writeText(data.wallet_address); setMessage(paymentStatus, "Merchant wallet address copied."); }
          catch (_) { setMessage(paymentStatus, "Copy is unavailable. Select and copy the wallet address above.", true); }
        });
        document.getElementById("vq-verify-tx").addEventListener("click", async function () {
          var hash = document.getElementById("vq-tx").value.trim();
          if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) { setMessage(paymentStatus, "Enter a valid transaction hash.", true); return; }
          var button = document.getElementById("vq-verify-tx"); button.disabled = true;
          try {
            var result = await post(endpoint + "/verify", { transaction_hash: hash });
            if (result.status === "paid") {
              setMessage(paymentStatus, "Payment received. Your merchant's order is confirmed.");
              document.getElementById("vq-crypto-wrap").hidden = true;
              document.getElementById("vq-paypal-wrap").hidden = true;
            } else setMessage(paymentStatus, result.message || "Transaction is not confirmed yet. Check again in a moment.");
          } catch (error) { setMessage(paymentStatus, error.message, true); }
          button.disabled = false;
        });
      }
      if (!(data.methods && (data.methods.paypal || data.methods.crypto))) setMessage(paymentStatus, "The merchant has no online payment method enabled for this order.", true);
    } catch (error) {
      setMessage(status, error.message || "Checkout could not be loaded.", true);
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
