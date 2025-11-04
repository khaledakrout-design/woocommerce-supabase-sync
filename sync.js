/**
 * sync.js
 * Script Node.js pour synchroniser WooCommerce -> Supabase via GitHub Actions (cron).
 * Utilise la fetch API native (Node 18+ / Node 20).
 *
 * Exigences: configurer les secrets GitHub (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * WOOCOMMERCE_URL, WOOCOMMERCE_CONSUMER_KEY, WOOCOMMERCE_CONSUMER_SECRET).
 */

const PER_PAGE = 100;
const CHUNK_SIZE = 500; // taille d'upsert par chunk

// small sleep helper
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
    console.log(`➡️ Fetching ${itemName} page ${page} -> ${url}`);
    const res = await fetch(url, { timeout: 120000 });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} when fetching ${itemName} page ${page} - ${txt}`);
    }
    const data = await res.json();
    console.log(`📦 Page ${page} -> ${Array.isArray(data) ? data.length : 'N/A'} ${itemName}`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    page++;
    // friendly pause to avoid throttling
    await sleep(400);
  }
  return all;
}

async function upsertChunks(supabaseUrl, supabaseKey, table, records) {
  if (!records || records.length === 0) {
    console.log(`ℹ️ No records to upsert for ${table}`);
    return;
  }

  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    console.log(`🔀 Upserting chunk ${i / CHUNK_SIZE + 1} (${chunk.length}) into ${table}...`);
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'resolution=merge-duplicates' // upsert-like behaviour
      },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Supabase upsert error for ${table}: ${res.status} ${body}`);
    }
    console.log(`✅ Chunk upserted (${i + chunk.length}/${records.length})`);
    await sleep(200); // small pause
  }
}

function formatOrderForSupabase(o) {
  return {
    order_id: String(o.id),
    created_at: o.date_created_gmt ? o.date_created_gmt + 'Z' : new Date().toISOString(),
    customer_name: `${(o.billing?.first_name || '')} ${(o.billing?.last_name || '')}`.trim() || 'Client inconnu',
    total: parseFloat(o.total || '0') || 0,
    payment_method: o.payment_method_title || 'N/A',
    status: o.status || 'unknown'
  };
}

function formatProductForSupabase(p) {
  return {
    product_id: String(p.id),
    name: p.name || 'N/A',
    category: Array.isArray(p.categories) && p.categories.length > 0 ? p.categories[0].name : 'Non classé',
    price: parseFloat(p.price || '0') || 0,
    stock: p.stock_quantity ?? 0,
    total_sales: p.total_sales ?? 0
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
    const productsBase = `${WOOCOMMERCE_URL}/wp-json/wc/v3/products?consumer_key=${encodeURIComponent(WC_KEY)}&consumer_secret=${encodeURIComponent(WC_SECRET)}`;

    // Fetch orders (paginated)
    console.log('🔎 Fetching orders (paginated)');
    const allOrders = await fetchAllPages(ordersBase, 'orders');
    console.log(`📦 Total orders fetched: ${allOrders.length}`);

    // Format & upsert orders in chunks
    const formattedOrders = allOrders.map(formatOrderForSupabase);
    if (formattedOrders.length > 0) {
      await upsertChunks(SUPABASE_URL, SUPABASE_KEY, 'sales', formattedOrders);
      console.log(`✅ Orders upsert completed (${formattedOrders.length})`);
    } else {
      console.log('⚠️ No orders to upsert');
    }

    // Fetch products (paginated)
    console.log('🔎 Fetching products (paginated)');
    const allProducts = await fetchAllPages(productsBase, 'products');
    console.log(`🛍️ Total products fetched: ${allProducts.length}`);

    // Format & upsert products
    const formattedProducts = allProducts.map(formatProductForSupabase);
    if (formattedProducts.length > 0) {
      await upsertChunks(SUPABASE_URL, SUPABASE_KEY, 'products', formattedProducts);
      console.log(`✅ Products upsert completed (${formattedProducts.length})`);
    } else {
      console.log('⚠️ No products to upsert');
    }

    console.log(`🎉 Synchronization finished: ${formattedOrders.length} orders, ${formattedProducts.length} products.`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Sync failed:', err.message || err);
    process.exit(1);
  }
}

main();
