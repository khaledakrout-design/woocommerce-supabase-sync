/**
 * sync.js — WooCommerce Orders -> Supabase (BI Perfume-Me)
 * Synchronisation centrée sur les commandes + top produits vendus
 */

const PER_PAGE = 100;
const CHUNK_SIZE = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getEnvOrThrow = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
};

async function fetchAllPages(baseUrl, itemName = 'items') {
  const all = [];
  let page = 1;
  while (true) {
    const url = `${baseUrl}&page=${page}&per_page=${PER_PAGE}`;
    console.log(`➡️ Fetching ${itemName} page ${page}`);
    const res = await fetch(url, { timeout: 120000 });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} when fetching ${itemName} page ${page} - ${txt}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    page++;
    await sleep(300);
  }
  return all;
}

async function upsertChunks(supabaseUrl, supabaseKey, table, records) {
  if (!records?.length) return console.log(`ℹ️ No records to upsert for ${table}`);
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Supabase upsert error for ${table}: ${res.status} ${body}`);
    }
    console.log(`✅ Upserted ${chunk.length} records into ${table}`);
    await sleep(200);
  }
}

function formatOrderForSupabase(o) {
  return {
    order_id: String(o.id),
    created_at: o.date_created_gmt ? o.date_created_gmt + 'Z' : new Date().toISOString(),
    customer_name: `${(o.billing?.first_name || '')} ${(o.billing?.last_name || '')}`.trim() || 'Client inconnu',
    total: parseFloat(o.total || '0') || 0,
    payment_method: o.payment_method_title || 'N/A',
    status: o.status || 'unknown',
  };
}

async function main() {
  try {
    const SUPABASE_URL = getEnvOrThrow('SUPABASE_URL').replace(/\/$/, '');
    const SUPABASE_KEY = getEnvOrThrow('SUPABASE_SERVICE_ROLE_KEY');
    const WOOCOMMERCE_URL = getEnvOrThrow('WOOCOMMERCE_URL').replace(/\/$/, '');
    const WC_KEY = getEnvOrThrow('WOOCOMMERCE_CONSUMER_KEY');
    const WC_SECRET = getEnvOrThrow('WOOCOMMERCE_CONSUMER_SECRET');

    console.log('🚀 Starting WooCommerce -> Supabase sync');

    const ordersBase = `${WOOCOMMERCE_URL}/wp-json/wc/v3/orders?consumer_key=${encodeURIComponent(WC_KEY)}&consumer_secret=${encodeURIComponent(WC_SECRET)}`;

    // 1️⃣ Fetch orders
    const allOrders = await fetchAllPages(ordersBase, 'orders');
    console.log(`📦 Total orders fetched: ${allOrders.length}`);

    // 2️⃣ Format and upsert orders
    const formattedOrders = allOrders.map(formatOrderForSupabase);
    await upsertChunks(SUPABASE_URL, SUPABASE_KEY, 'sales', formattedOrders);

    // 3️⃣ Extract and aggregate top-selling products from order items
    const productStats = {};

    for (const order of allOrders) {
      if (!Array.isArray(order.line_items)) continue;
      for (const item of order.line_items) {
        const pid = String(item.product_id);
        if (!productStats[pid]) {
          productStats[pid] = {
            product_id: pid,
            name: item.name || 'Produit inconnu',
            total_sold: 0,
            total_revenue: 0,
            last_sold_date: order.date_created_gmt ? order.date_created_gmt + 'Z' : new Date().toISOString(),
          };
        }
        productStats[pid].total_sold += item.quantity || 0;
        productStats[pid].total_revenue += parseFloat(item.total || '0') || 0;
      }
    }

    // 4️⃣ Convert object to array and keep only top X products (e.g., 50)
    const topProducts = Object.values(productStats)
      .sort((a, b) => b.total_sold - a.total_sold)
      .slice(0, 50);

    // 5️⃣ Upsert top products into Supabase
    await upsertChunks(SUPABASE_URL, SUPABASE_KEY, 'products', topProducts);

    console.log(`🎯 Top ${topProducts.length} products synced successfully.`);
    console.log(`🎉 Synchronization finished: ${formattedOrders.length} orders processed.`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Sync failed:', err.message || err);
    process.exit(1);
  }
}

main();
