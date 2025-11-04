// On importe node-fetch comme demandé, bien que fetch soit natif dans Node 20.
// Cela garantit la compatibilité et respecte la contrainte.
import fetch from 'node-fetch';

// --- Configuration et Secrets ---
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  WOOCOMMERCE_URL,
  WOOCOMMERCE_CONSUMER_KEY,
  WOOCOMMERCE_CONSUMER_SECRET
} = process.env;

// Constantes pour la pagination et la courtoisie API
const PER_PAGE = 100;
const DELAY_MS = 500; // 500ms de pause entre les appels API pour éviter le throttling

// --- Validation des secrets ---
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !WOOCOMMERCE_URL || !WOOCOMMERCE_CONSUMER_KEY || !WOOCOMMERCE_CONSUMER_SECRET) {
  console.error("❌ Erreur critique : Une ou plusieurs variables d'environnement sont manquantes. Vérifiez les secrets GitHub.");
  process.exit(1);
}

// --- Fonctions Utilitaires ---

/**
 * Petite pause pour être respectueux envers l'API WooCommerce.
 * @param {number} ms - Durée de la pause en millisecondes.
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Récupère les données paginées de l'API WooCommerce.
 * @param {string} endpoint - Le chemin de l'API (ex: '/products').
 * @param {number|null} recordLimit - Le nombre maximum d'enregistrements à récupérer (null pour tous).
 * @returns {Promise<Array<any>>} - Une liste de tous les enregistrements récupérés.
 */
async function fetchWooCommerceData(endpoint, recordLimit = null) {
  const allData = [];
  let page = 1;
  const entityName = endpoint.replace('/', '');

  console.log(`🚀 Démarrage de la récupération pour : ${entityName}`);

  while (true) {
    const url = `${WOOCOMMERCE_URL}/wp-json/wc/v3${endpoint}?per_page=${PER_PAGE}&page=${page}&consumer_key=${WOOCOMMERCE_CONSUMER_KEY}&consumer_secret=${WOOCOMMERCE_CONSUMER_SECRET}`;
    
    console.log(`- 📥 Fetching ${entityName}, page ${page}...`);
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Erreur API WooCommerce pour ${endpoint} (page ${page}): ${response.status} ${response.statusText}`);
    }
    
    const pageData = await response.json();

    if (pageData.length === 0) {
      console.log(`- ✅ Fin de la récupération pour ${entityName}. Aucune donnée sur la page ${page}.`);
      break; // Sortie de la boucle, plus de données à récupérer
    }
    
    console.log(`- 📦 Page ${page} → ${pageData.length} ${entityName} reçus.`);
    allData.push(...pageData);

    if (recordLimit && allData.length >= recordLimit) {
        console.log(`- 🏁 Limite de ${recordLimit} enregistrements atteinte pour ${entityName}.`);
        return allData.slice(0, recordLimit);
    }
    
    page++;
    await sleep(DELAY_MS);
  }
  
  return allData;
}

/**
 * Met à jour (upsert) les données dans une table Supabase via l'API REST.
 * @param {string} table - Le nom de la table Supabase.
 * @param {Array<any>} data - Les données à insérer/mettre à jour.
 */
async function upsertSupabaseData(table, data) {
    if (data.length === 0) {
        console.log(`- 🤷 Aucune donnée à synchroniser pour la table "${table}".`);
        return;
    }
  console.log(`-  supabase 🔄 Synchronisation de ${data.length} enregistrements vers la table "${table}"...`);
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates' // La magie de l'upsert
    },
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erreur Supabase lors de l'upsert dans "${table}": ${response.status} ${response.statusText} - ${errorText}`);
  }
  
  console.log(`- supabase ✅ Succès : ${data.length} enregistrements synchronisés dans "${table}".`);
}

/**
 * Transforme un objet commande WooCommerce pour la table 'sales' de Supabase.
 */
const formatOrder = (o) => ({
  order_id: o.id.toString(),
  created_at: o.date_created_gmt + "Z",
  customer_name: `${o.billing.first_name || ""} ${o.billing.last_name || ""}`.trim() || 'Client inconnu',
  total: parseFloat(o.total || "0"),
  payment_method: o.payment_method_title || 'N/A',
  status: o.status,
});

/**
 * Transforme un objet produit WooCommerce pour la table 'products' de Supabase.
 */
const formatProduct = (p) => ({
  product_id: p.id.toString(),
  name: p.name,
  category: p.categories.length > 0 ? p.categories[0].name : "Non classé",
  price: parseFloat(p.price || "0"),
  stock: p.stock_quantity ?? 0,
  total_sales: p.total_sales,
});

// --- Script Principal ---
async function main() {
  console.log("--- ✨ Démarrage de la synchronisation WooCommerce -> Supabase ---");
  const startTime = Date.now();
  
  try {
    // 1. Synchronisation des 500 dernières commandes
    const rawOrders = await fetchWooCommerceData('/orders', 500);
    const allowedStatuses = ['completed', 'processing', 'refunded'];
    const formattedOrders = rawOrders
        .filter(o => allowedStatuses.includes(o.status))
        .map(formatOrder);
    await upsertSupabaseData('sales', formattedOrders);
    
    // 2. Synchronisation de TOUS les produits
    const rawProducts = await fetchWooCommerceData('/products');
    const formattedProducts = rawProducts.map(formatProduct);
    await upsertSupabaseData('products', formattedProducts);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n--- ✅ Synchronisation complète terminée en ${duration}s ---`);
    console.log(`- Commandes traitées : ${formattedOrders.length}`);
    console.log(`- Produits traités : ${formattedProducts.length}`);
    
  } catch (error) {
    console.error("\n--- ❌ ERREUR FATALE PENDANT LA SYNCHRONISATION ---");
    console.error(error);
    process.exit(1); // Très important pour que GitHub Action signale un échec
  }
}

main();
