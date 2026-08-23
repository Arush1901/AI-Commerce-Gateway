'use strict';

const catalog = require('./data/catalog.json');

/**
 * Search the catalog by category and/or maxPrice.
 *
 * @param {Object} params
 * @param {string} [params.category]  - Filter by product category (e.g. "headset")
 * @param {number} [params.maxPrice]  - Exclude products with price > maxPrice
 * @returns {CatalogProduct[]}        - Matching products (never mutates source)
 */
function searchCatalog({ category, maxPrice } = {}) {
  return catalog.filter((product) => {
    if (category !== undefined && product.category !== category) return false;
    if (maxPrice !== undefined && product.price > maxPrice) return false;
    return true;
  });
}

module.exports = { searchCatalog };
