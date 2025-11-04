/**
 * sync.js
 * WooCommerce → Supabase (Orders & Products)
 * Compatible avec les tables : `sales` et `products`
 * 
 * Nécessite les secrets :
 *  - SUPABASE_URL
 *  - SUPABASE_KEY (service_role)
 *  - WOOCOMMERCE_URL
 *  - WOOCOMMERCE_CONSUMER_KEY
 *  - WOOCOMMERCE_CONSUMER_SECRET
 */

import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const PER_PAGE = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getEnv = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`❌ Missing env var: ${name}`);
  return v;
};

const SUPABASE_URL = getEnv("SUPABASE_URL");
const SUPABASE_KEY = getEnv("SUPABASE_KEY");
const WOOCOMMERCE_URL = getEnv("WOOCOMMERCE_URL");
const WC_KEY = getEnv("WOOCOMMERCE_CONSUMER_KEY");
const WC_SECRET = getEnv("WOOCOMMERCE_CONSUMER_SECRET");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchAllPages(baseUrl, itemName = "items") {
  const all = [];
  let page = 1;
  while (true) {
    const url = `${baseUrl}&page=${page}&per_page=${PER_PAGE}`;
    console.log(`➡️ Fetching ${itemName} page ${page}`);
    const res = await fetch(url);
    if (!res.ok) break;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    page++;
    await sleep(500);
  }
  console.log(`📦 Total ${itemName} fetched: ${all.length}`);
  return all;
}

// Formatters
function formatOrder(o) {
  return {
    order_id: String(o.id),
    created_at: o.date_created_gmt ? o.date_created_gmt + "Z" : new Date().toISOString(),
    customer_name: `${(o.billing?.first_name || "")} ${(o.billing?.last_name || "")}`.trim() || "Client inconnu",
    total: parseFloat(o.total || "0") || 0,
    payment_method: o.payment_method_title || "N/A",
    status: o.status || "unknown",
  };
}

function formatProduct(p) {
  return {
    product_id: String(p.id),
    name: p.name || "N/A",
    category: Array.isArray(p.categories) && p.categories.length > 0 ? p.categories[0].name : "Non classé",
    price: parseFloat(p.price || "0") || 0,
    stock: p.stock_quantity ?? 0,
    total_sales: parseFloat(p.total_sales || "0") || 0
  };
}

async function main() {
  console.log("🚀 Starting WooCommerce → Supabase sync");

  const ordersBase = `${WOOCOMMERCE_URL}/wp-json/wc/v3/orders?consumer_key=${WC_KEY}&consumer_secret=${WC_SECRET}`;
  const productsBase = `${WOOCOMMERCE_URL}/wp-json/wc/v3/products?consumer_key=${WC_KEY}&consumer_secret=${WC_SECRET}`;

  // 1️⃣ Orders
  const allOrders = await fetchAllPages(ordersBase, "orders");
  if (allOrders.length) {
    const formatted = allOrders.map(formatOrder);
    const { error } = await supabase.from("sales").upsert(formatted, { onConflict: "order_id" });
    if (error) throw error;
    console.log(`✅ Orders upserted: ${formatted.length}`);
  } else console.log("⚠️ No orders found.");

  // 2️⃣ Products
  const allProducts = await fetchAllPages(productsBase, "products");
  if (allProducts.length) {
    // 🧠 Optionnel : ne garder que les produits les plus vendus
    const top = allProducts.filter((p) => parseInt(p.total_sales || 0) > 5); // ajustable
    const formatted = top.map(formatProduct);
    const { error } = await supabase.from("products").upsert(formatted, { onConflict: "product_id" });
    if (error) throw error;
    console.log(`✅ Products upserted: ${formatted.length}`);
  } else console.log("⚠️ No products found.");

  console.log("🎉 Sync completed successfully!");
}

main().catch((err) => {
  console.error("❌ Sync failed:", err.message || err);
  process.exit(1);
});
