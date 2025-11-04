// fetchOrders.js
async function fetchOrders() {
  try {
    const response = await fetch(
      'https://perfume-me.com/wp-json/wc/v3/orders?consumer_key=ck_xxxxx&consumer_secret=cs_xxxxx&per_page=100'
    );

    if (!response.ok) {
      throw new Error(`Erreur HTTP : ${response.status}`);
    }

    const orders = await response.json();

    // 🧠 Exemple d’analyse BI locale
    const analytics = {
      totalOrders: orders.length,
      totalRevenue: orders.reduce((sum, order) => sum + parseFloat(order.total), 0),
      averageOrderValue:
        orders.reduce((sum, order) => sum + parseFloat(order.total), 0) / orders.length,
      topCustomers: getTopCustomers(orders),
      topProducts: getTopProducts(orders),
      salesByDate: getSalesByDate(orders),
    };

    console.log("📊 BI Analytics:", analytics);
    return analytics;

  } catch (error) {
    console.error("Erreur lors du fetching des commandes:", error);
  }
}

function getTopCustomers(orders) {
  const customers = {};
  orders.forEach(order => {
    const email = order.billing.email || 'inconnu';
    customers[email] = (customers[email] || 0) + parseFloat(order.total);
  });
  return Object.entries(customers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([email, total]) => ({ email, total }));
}

function getTopProducts(orders) {
  const products = {};
  orders.forEach(order => {
    order.line_items.forEach(item => {
      products[item.name] = (products[item.name] || 0) + item.quantity;
    });
  });
  return Object.entries(products)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, qty]) => ({ name, qty }));
}

function getSalesByDate(orders) {
  const sales = {};
  orders.forEach(order => {
    const date = order.date_created.substring(0, 10);
    sales[date] = (sales[date] || 0) + parseFloat(order.total);
  });
  return sales;
}

// 🔹 Appel principal
fetchOrders();
