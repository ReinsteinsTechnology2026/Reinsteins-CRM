// Shared currency formatting for the Platform payment UI. The
// `payments` table's currency column defaults to INR (ZioVenture's
// initial market) but is not hardcoded server-side, so this stays
// symbol-aware rather than assuming ₹ everywhere.

const CURRENCY_SYMBOLS = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

export function formatMoney(amount, currency = "INR") {
  const symbol = CURRENCY_SYMBOLS[currency] || `${currency} `;
  const value = Number(amount) || 0;
  return `${symbol}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default formatMoney;
