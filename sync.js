/**
 * sync.js - Optimized Version
 * WooCommerce → Supabase (Orders & Top Products Only)
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

  // 1️⃣ Fetch all orders
  const allOrders = await fetchAllPages(ordersBase, "orders");
  if (!allOrders.length) {
    console.log("⚠️ No orders found.");
    return;
  }

  // Insert orders
  const formattedOrders = allOrders.map(formatOrder);
  const { error: orderError } = await supabase.from("sales").upsert(formattedOrders, { onConflict: "order_id" });
  if (orderError) throw orderError;
  console.log(`✅ Orders upserted: ${formattedOrders.length}`);

  // 2️⃣ Extract unique product IDs from order line items
  const productIds = [
    ...new Set(allOrders.flatMap(o => (o.line_items || []).map(i => i.product_id)))
  ];

  console.log(`🧠 Found ${productIds.length} unique products in orders.`);

  // 3️⃣ Fetch only these products
  const topProducts = [];
  for (const id of productIds) {
    const url = `${WOOCOMMERCE_URL}/wp-json/wc/v3/products/${id}?consumer_key=${WC_KEY}&consumer_secret=${WC_SECRET}`;
    const res = await fetch(url);
    if (res.ok) {
      const p = await res.json();
      topProducts.push(p);
      await sleep(300);
    }
  }

  // 4️⃣ Upsert these products
  if (topProducts.length) {
    const formattedProducts = topProducts.map(formatProduct);
    const { error: productError } = await supabase.from("products").upsert(formattedProducts, { onConflict: "product_id" });
    if (productError) throw productError;
    console.log(`✅ Products upserted: ${formattedProducts.length}`);
  } else {
    console.log("⚠️ No products linked to orders found.");
  }

  console.log("🎉 Sync completed successfully!");
}

main().catch((err) => {
  console.error("❌ Sync failed:", err.message || err);
  process.exit(1);
});
