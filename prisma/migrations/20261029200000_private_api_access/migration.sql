REVOKE ALL PRIVILEGES ON TABLE
  "User",
  "OAuthAccount",
  "VerificationToken",
  "Address",
  "Category",
  "Product",
  "ProductImage",
  "Inventory",
  "Cart",
  "CartItem",
  "WishlistItem",
  "Order",
  "OrderItem",
  "Payment",
  "Promotion",
  "Coupon",
  "Banner",
  "StoreSetting",
  "_prisma_migrations"
FROM PUBLIC;

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE
          "User", "OAuthAccount", "VerificationToken", "Address", "Category",
          "Product", "ProductImage", "Inventory", "Cart", "CartItem",
          "WishlistItem", "Order", "OrderItem", "Payment", "Promotion",
          "Coupon", "Banner", "StoreSetting", "_prisma_migrations"
         FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$$;
