import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const woocommerceUrl = process.env.WOOCOMMERCE_URL;
const consumerKey = process.env.WOOCOMMERCE_CONSUMER_KEY;
const consumerSecret = process.env.WOOCOMMERCE_CONSUMER_SECRET;

async function fetchOrders(page = 1, allOrders = []) {
  console.log(`➡️ Fetching orders page ${page}`);
  const response = await fetch(`${woocommerceUrl}/wp-json/wc/v3/orders?per_page=100&page=${page}`, {
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64"),
    },
  });
  const orders = await response.json();
  allOrders = [...allOrders, ...orders];
  if (orders.length === 100) {
    return fetchOrders(page + 1, allOrders);
  }
  return allOrders;
}

async function syncData() {
  console.log("🚀 Starting WooCommerce -> Supabase sync");

  const orders = await fetchOrders();
  console.log(`📦 Total orders fetched: ${orders.length}`);

  // Préparation des données pour "sales"
  const salesData = orders.map((order) => ({
    order_id: order.id.toString(),
    date: order.date_created,
    customer_name: order.billing.first_name + " " + order.billing.last_name,
    total: parseFloat(order.total),
    payment_method: order.payment_method_title,
    status: order.status,
  }));

  const { error: salesError } = await supabase.from("sales").upsert(salesData, { onConflict: "order_id" });
  if (salesError) {
    console.error("❌ Supabase upsert error for sales:", salesError);
    process.exit(1);
  }

  // --- Récupération des produits les plus vendus ---
  const productSales = {};
  orders.forEach((order) => {
    order.line_items.forEach((item) => {
      const id = item.product_id.toString();
      if (!productSales[id]) {
        productSales[id] = {
          product_id: id,
          name: item.name,
          category: item.category || null,
          price: parseFloat(item.price),
          stock: null, // on ne le récupère pas ici
          total_sales: 0,
        };
      }
      productSales[id].total_sales += parseFloat(item.total);
    });
  });

  // Tri des produits les plus vendus
  const topProducts = Object.values(productSales)
    .sort((a, b) => b.total_sales - a.total_sales)
    .slice(0, 50); // 💡 on ne garde que les 50 produits les plus vendus

  const { error: productsError } = await supabase
    .from("products")
    .upsert(topProducts, { onConflict: "product_id" });

  if (productsError) {
    console.error("❌ Supabase upsert error for products:", productsError);
    process.exit(1);
  }

  console.log(`✅ Upserted ${salesData.length} sales and ${topProducts.length} top products.`);
}

syncData().catch((err) => {
  console.error("❌ Sync failed:", err);
  process.exit(1);
});
