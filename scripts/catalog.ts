// Khareedo demo catalog — shared by seed script and image generator.
// Prices are INTEGER PKR (whole rupees). comparePrice = "was" price for discount badges.

export interface SeedCategory {
  name: string;
  slug: string;
  description: string;
  parent?: string; // slug of parent category
  sortOrder: number;
}

export interface SeedProduct {
  name: string;
  slug: string;
  brand: string;
  category: string; // leaf category slug
  price: number;
  comparePrice?: number;
  description: string;
  rating: number;
  reviewCount: number;
  stock: number;
  tags: string[];
  featured?: boolean;
  imagePrompt: string;
}

export const PARENT_CATEGORIES: SeedCategory[] = [
  { name: "Watches", slug: "watches", description: "Analog, digital and smart watches for everyone", sortOrder: 1 },
  { name: "Electronics", slug: "electronics", description: "Smart gadgets and everyday electronics", sortOrder: 2 },
  { name: "Bags", slug: "bags", description: "Handbags and carry essentials", sortOrder: 3 },
  { name: "Jewellery", slug: "jewellery", description: "Elegant artificial jewellery collections", sortOrder: 4 },
  { name: "Accessories", slug: "accessories", description: "Wallets and daily accessories", sortOrder: 5 },
  { name: "Perfumes", slug: "perfumes", description: "Fragrances for every occasion", sortOrder: 6 },
];

export const LEAF_CATEGORIES: SeedCategory[] = [
  { name: "Men's Watches", slug: "mens-watches", description: "Classic and chronograph watches for men", parent: "watches", sortOrder: 1 },
  { name: "Ladies' Watches", slug: "ladies-watches", description: "Elegant watches crafted for women", parent: "watches", sortOrder: 2 },
  { name: "Smart Watches", slug: "smart-watches", description: "Fitness trackers and smart watches", parent: "electronics", sortOrder: 3 },
  { name: "Earbuds", slug: "earbuds", description: "True wireless earbuds with premium sound", parent: "electronics", sortOrder: 4 },
  { name: "Ladies' Handbags", slug: "ladies-handbags", description: "Trendy handbags for every outfit", parent: "bags", sortOrder: 5 },
  { name: "Artificial Jewellery", slug: "artificial-jewellery", description: "Necklaces, earrings, bangles and sets", parent: "jewellery", sortOrder: 6 },
  { name: "Men's Wallets", slug: "mens-wallets", description: "Genuine leather wallets for men", parent: "accessories", sortOrder: 7 },
  { name: "Mobile Accessories", slug: "mobile-accessories", description: "Chargers, cables, power banks and mounts", parent: "electronics", sortOrder: 9 },
  { name: "Couple Watches", slug: "couple-watches", description: "Matching watch sets for couples", parent: "watches", sortOrder: 10 },
];

const IMG_STYLE =
  "professional e-commerce product photography, single product centered on a clean warm beige studio background, soft natural shadow, no text, no watermark, high quality, detailed";

export const PRODUCTS: SeedProduct[] = [
  // ─── Men's Watches ───
  {
    name: "Casio Men's Analog Watch", slug: "casio-mens-analog-watch", brand: "Casio", category: "mens-watches",
    price: 8999, comparePrice: 10999, rating: 4.7, reviewCount: 214, stock: 24, featured: true,
    description: "A timeless stainless-steel analog watch with a black dial, date window and quartz precision. Water-resistant and built for everyday wear.",
    tags: ["analog", "steel", "casual", "formal"], imagePrompt: "black dial stainless steel men's analog wrist watch, " + IMG_STYLE,
  },
  {
    name: "Naviforce Luxury Chronograph", slug: "naviforce-luxury-chronograph", brand: "Naviforce", category: "mens-watches",
    price: 4499, comparePrice: 5999, rating: 4.5, reviewCount: 186, stock: 31,
    description: "Bold chronograph design with a working sub-dial layout, luminous hands and a durable alloy bracelet. A statement piece at a friendly price.",
    tags: ["chronograph", "luxury", "naviforce"], imagePrompt: "silver and blue chronograph men's wrist watch with steel bracelet, " + IMG_STYLE,
  },
  {
    name: "Curren Stainless Steel Watch", slug: "curren-stainless-steel-watch", brand: "Curren", category: "mens-watches",
    price: 3299, comparePrice: 4299, rating: 4.3, reviewCount: 132, stock: 40,
    description: "Slim stainless-steel case with a mesh bracelet and minimalist dial. Versatile enough for the office and evenings out.",
    tags: ["minimal", "steel", "mesh"], imagePrompt: "minimalist men's wrist watch with mesh steel strap and white dial, " + IMG_STYLE,
  },
  {
    name: "Timex Classic Leather Watch", slug: "timex-classic-leather-watch", brand: "Timex", category: "mens-watches",
    price: 9499, comparePrice: 11999, rating: 4.8, reviewCount: 98, stock: 12, featured: true,
    description: "Heritage-inspired design with a genuine leather strap, cream dial and Indiglo night-light. Reliable quartz movement by Timex.",
    tags: ["leather", "classic", "timex"], imagePrompt: "men's wrist watch with brown leather strap and cream dial, " + IMG_STYLE,
  },
  {
    name: "Skmei Sport Digital Watch", slug: "skmei-sport-digital-watch", brand: "Skmei", category: "mens-watches",
    price: 1999, comparePrice: 2599, rating: 4.2, reviewCount: 240, stock: 55,
    description: "Rugged digital sports watch with stopwatch, alarm and backlight. Shock-resistant body with 30m water resistance.",
    tags: ["digital", "sport", "waterproof"], imagePrompt: "black digital sports wrist watch with rubber strap, " + IMG_STYLE,
  },
  {
    name: "Fossil Townsman Chronograph", slug: "fossil-townsman-chronograph", brand: "Fossil", category: "mens-watches",
    price: 24999, rating: 4.9, reviewCount: 64, stock: 7,
    description: "Premium Fossil Townsman with a sunray dial, genuine leather strap and precision chronograph movement. Gift-box packaging included.",
    tags: ["premium", "fossil", "gift"], imagePrompt: "premium men's chronograph wrist watch with tan leather strap and navy dial, " + IMG_STYLE,
  },

  // ─── Ladies' Watches ───
  {
    name: "Rose Gold Mesh Ladies Watch", slug: "rose-gold-mesh-ladies-watch", brand: "Curren", category: "ladies-watches",
    price: 3999, comparePrice: 4999, rating: 4.6, reviewCount: 175, stock: 28, featured: true,
    description: "Delicate rose-gold mesh bracelet with a slim case and mother-of-pearl style dial. Lightweight and elegant for all-day wear.",
    tags: ["rose gold", "mesh", "elegant"], imagePrompt: "rose gold women's wrist watch with mesh strap and white dial, " + IMG_STYLE,
  },
  {
    name: "Minicity Elegant Slim Watch", slug: "minicity-elegant-slim-watch", brand: "Minicity", category: "ladies-watches",
    price: 2899, comparePrice: 3599, rating: 4.4, reviewCount: 121, stock: 35,
    description: "Ultra-slim profile with a tiny round dial and thin strap. A subtle everyday accessory that pairs with anything.",
    tags: ["slim", "minimal", "everyday"], imagePrompt: "slim elegant women's wrist watch with thin strap and small dial, " + IMG_STYLE,
  },
  {
    name: "Anne Klein Bracelet Watch", slug: "anne-klein-bracelet-watch", brand: "Anne Klein", category: "ladies-watches",
    price: 12999, comparePrice: 14999, rating: 4.8, reviewCount: 87, stock: 10, featured: true,
    description: "Iconic bracelet-style watch with crystal-set bezel and matching link band. A jewellery piece that tells time.",
    tags: ["bracelet", "crystal", "gift"], imagePrompt: "gold women's bracelet wrist watch with crystal bezel, " + IMG_STYLE,
  },
  {
    name: "Leather Strap Ladies Watch", slug: "leather-strap-ladies-watch", brand: "Timex", category: "ladies-watches",
    price: 4999, rating: 4.5, reviewCount: 96, stock: 18,
    description: "Soft pastel leather strap with a polished round case and easy-to-read dial. Comfortable fit with quick-release pins.",
    tags: ["leather", "pastel", "casual"], imagePrompt: "women's wrist watch with blush pink leather strap and gold case, " + IMG_STYLE,
  },

  // ─── Smart Watches ───
  {
    name: "Smart Watch Pro Series 8", slug: "smart-watch-pro-series-8", brand: "KhareedoTech", category: "smart-watches",
    price: 5999, comparePrice: 7999, rating: 4.4, reviewCount: 312, stock: 45, featured: true,
    description: "1.9-inch AMOLED display, Bluetooth calling, SpO2 and heart-rate tracking, 100+ sport modes and 7-day battery life.",
    tags: ["smartwatch", "fitness", "calling"], imagePrompt: "modern black smart watch with square AMOLED screen showing fitness stats, " + IMG_STYLE,
  },
  {
    name: "Xiaomi Smart Band 8", slug: "xiaomi-smart-band-8", brand: "Xiaomi", category: "smart-watches",
    price: 6499, comparePrice: 7499, rating: 4.6, reviewCount: 268, stock: 33,
    description: "Featherlight fitness band with a bright 1.62-inch display, 16-day battery, 150+ watch faces and full health suite.",
    tags: ["fitness band", "xiaomi", "health"], imagePrompt: "slim black fitness tracker band with curved display, " + IMG_STYLE,
  },
  {
    name: "HT66 Fitness Tracker", slug: "ht66-fitness-tracker", brand: "HT66", category: "smart-watches",
    price: 2199, comparePrice: 2999, rating: 4.1, reviewCount: 197, stock: 60,
    description: "Budget-friendly tracker with steps, sleep, heart-rate monitoring and IP67 water resistance. Perfect first fitness band.",
    tags: ["budget", "tracker", "fitness"], imagePrompt: "simple black fitness tracker wristband with small touch screen, " + IMG_STYLE,
  },
  {
    name: "AMOLED Smart Watch Ultra", slug: "amoled-smart-watch-ultra", brand: "KhareedoTech", category: "smart-watches",
    price: 8999, comparePrice: 11999, rating: 4.7, reviewCount: 156, stock: 21, featured: true,
    description: "Titanium-style casing, 2.0-inch always-on AMOLED screen, built-in compass, Bluetooth calls and wireless charging.",
    tags: ["premium", "amoled", "ultra"], imagePrompt: "premium rugged smart watch with titanium case and orange accent strap, " + IMG_STYLE,
  },
  {
    name: "Bluetooth Calling Watch T900", slug: "bluetooth-calling-watch-t900", brand: "T900", category: "smart-watches",
    price: 1799, comparePrice: 2499, rating: 4.0, reviewCount: 421, stock: 80,
    description: "Answer calls from your wrist with speaker and mic, plus notifications, music control and multiple dial faces.",
    tags: ["calling", "budget", "t900"], imagePrompt: "black smart watch with circular dial showing call screen, " + IMG_STYLE,
  },
  {
    name: "Fitbit Inspire 3", slug: "fitbit-inspire-3", brand: "Fitbit", category: "smart-watches",
    price: 19999, rating: 4.8, reviewCount: 74, stock: 9,
    description: "Genuine Fitbit Inspire 3 with stress management, sleep score, 24/7 heart rate and 10-day battery in a slim tracker.",
    tags: ["fitbit", "premium", "health"], imagePrompt: "slim navy fitness tracker band with silicone strap, " + IMG_STYLE,
  },

  // ─── Earbuds ───
  {
    name: "Soundpeats Q3 Pro ANC", slug: "soundpeats-q3-pro-anc", brand: "Soundpeats", category: "earbuds",
    price: 5699, comparePrice: 6299, rating: 4.8, reviewCount: 74, stock: 26, featured: true,
    description: "Hybrid active noise cancellation, 35-hour total playtime, low-latency gaming mode and crystal-clear ENC calls.",
    tags: ["anc", "wireless", "soundpeats"], imagePrompt: "glossy black wireless earbuds with open charging case, " + IMG_STYLE,
  },
  {
    name: "Apple AirPods 2nd Generation", slug: "apple-airpods-2nd-generation", brand: "Apple", category: "earbuds",
    price: 44999, rating: 4.9, reviewCount: 120, stock: 8, featured: true,
    description: "Genuine Apple AirPods (2nd gen) with H1 chip, hands-free 'Hey Siri', fast pairing and the iconic open-fit design.",
    tags: ["apple", "airpods", "premium"], imagePrompt: "white wireless earbuds with short stems and open white charging case, " + IMG_STYLE,
  },
  {
    name: "boAt Airdopes 141", slug: "boat-airdopes-141", brand: "boAt", category: "earbuds",
    price: 3999, comparePrice: 4999, rating: 4.4, reviewCount: 92, stock: 42,
    description: "42-hour playback, ENx environmental noise cancellation, low-latency BEAST mode and IPX4 splash resistance.",
    tags: ["boat", "gaming", "budget"], imagePrompt: "black wireless earbuds with charging case showing LED indicator, " + IMG_STYLE,
  },
  {
    name: "Realme Buds T300", slug: "realme-buds-t300", brand: "Realme", category: "earbuds",
    price: 7999, comparePrice: 8999, rating: 4.5, reviewCount: 86, stock: 19,
    description: "30dB active noise cancellation, 360° spatial audio, 12.4mm bass drivers and 40-hour total playback.",
    tags: ["anc", "realme", "bass"], imagePrompt: "matte black wireless earbuds standing beside closed charging case, " + IMG_STYLE,
  },
  {
    name: "JBL Wave Buds", slug: "jbl-wave-buds", brand: "JBL", category: "earbuds",
    price: 6799, comparePrice: 7999, rating: 4.5, reviewCount: 103, stock: 23,
    description: "Signature JBL Deep Bass Sound, 32-hour battery with speed charge, voice-aware calling and IP54 rating.",
    tags: ["jbl", "bass", "wireless"], imagePrompt: "compact black wireless earbuds case open with earbuds inside, " + IMG_STYLE,
  },
  {
    name: "Xiaomi Redmi Buds 5", slug: "xiaomi-redmi-buds-5", brand: "Xiaomi", category: "earbuds",
    price: 8999, rating: 4.6, reviewCount: 77, stock: 16,
    description: "46dB hybrid ANC, 12.4mm titanium drivers, 40-hour battery and dual-device pairing in a lightweight design.",
    tags: ["xiaomi", "anc", "lightweight"], imagePrompt: "white wireless earbuds with minimalist open charging case, " + IMG_STYLE,
  },
  {
    name: "Anker Soundcore R50i", slug: "anker-soundcore-r50i", brand: "Anker", category: "earbuds",
    price: 6499, comparePrice: 7499, rating: 4.4, reviewCount: 56, stock: 29,
    description: "Big bass with 22 preset EQs via the app, 42-hour playtime, IPX5 waterproofing and low-latency game mode.",
    tags: ["anker", "bass", "waterproof"], imagePrompt: "dark blue wireless earbuds with textured charging case, " + IMG_STYLE,
  },
  {
    name: "Infinix XE27 Pro", slug: "infinix-xe27-pro", brand: "Infinix", category: "earbuds",
    price: 3499, comparePrice: 3999, rating: 4.2, reviewCount: 38, stock: 37,
    description: "Quad-mic ENC calling, 30-hour playback, 13mm drivers and ultra-low 45ms latency for videos and games.",
    tags: ["infinix", "budget", "calling"], imagePrompt: "green wireless earbuds with glossy charging case, " + IMG_STYLE,
  },

  // ─── Ladies' Handbags ───
  {
    name: "Classic Leather Handbag", slug: "classic-leather-handbag", brand: "Khareedo Collection", category: "ladies-handbags",
    price: 4999, comparePrice: 5999, rating: 4.7, reviewCount: 143, stock: 22, featured: true,
    description: "Structured premium-PU handbag with a top handle, detachable shoulder strap and gold-tone hardware. Fits a 10-inch tablet.",
    tags: ["handbag", "leather", "classic"], imagePrompt: "elegant beige leather handbag with gold clasp and top handle, " + IMG_STYLE,
  },
  {
    name: "Mini Crossbody Bag", slug: "mini-crossbody-bag", brand: "Khareedo Collection", category: "ladies-handbags",
    price: 2499, rating: 4.5, reviewCount: 98, stock: 30,
    description: "Compact crossbody with an adjustable strap, secure zip closure and a card slot inside. Hands-free essentials for outings.",
    tags: ["crossbody", "mini", "casual"], imagePrompt: "small tan crossbody bag with long thin strap, " + IMG_STYLE,
  },
  {
    name: "Premium Tote Bag", slug: "premium-tote-bag", brand: "Lavish", category: "ladies-handbags",
    price: 3899, comparePrice: 4599, rating: 4.6, reviewCount: 76, stock: 25,
    description: "Roomy tote in soft pebbled PU with laptop sleeve, magnet closure and interior zip pocket. Office-to-dinner favourite.",
    tags: ["tote", "office", "spacious"], imagePrompt: "large cream tote handbag with structured silhouette, " + IMG_STYLE,
  },
  {
    name: "Embroidered Evening Clutch", slug: "embroidered-evening-clutch", brand: "Zari", category: "ladies-handbags",
    price: 2899, comparePrice: 3499, rating: 4.4, reviewCount: 54, stock: 17,
    description: "Hand-embroidered clutch with beadwork, snap closure and a slim chain strap. A graceful plus-one for events.",
    tags: ["clutch", "embroidered", "party"], imagePrompt: "gold embroidered evening clutch bag with beadwork, " + IMG_STYLE,
  },
  {
    name: "Designer Shoulder Bag", slug: "designer-shoulder-bag", brand: "Lavish", category: "ladies-handbags",
    price: 6999, comparePrice: 7999, rating: 4.8, reviewCount: 61, stock: 11, featured: true,
    description: "Quilted shoulder bag with chain-and-leather strap, flap cover and plush lining. A wardrobe centrepiece.",
    tags: ["shoulder", "quilted", "designer"], imagePrompt: "black quilted shoulder handbag with gold chain strap, " + IMG_STYLE,
  },

  // ─── Artificial Jewellery ───
  {
    name: "Clover Necklace Set", slug: "clover-necklace-set", brand: "Aurelia", category: "artificial-jewellery",
    price: 1999, comparePrice: 2499, rating: 4.6, reviewCount: 187, stock: 44, featured: true,
    description: "Gold-plated clover pendant necklace with matching earrings. Tarnish-resistant finish on a stainless base.",
    tags: ["necklace", "clover", "gold"], imagePrompt: "delicate gold necklace with clover pendant and matching earrings, " + IMG_STYLE,
  },
  {
    name: "Gold Plated Bangles Set", slug: "gold-plated-bangles-set", brand: "Aurelia", category: "artificial-jewellery",
    price: 1499, rating: 4.3, reviewCount: 132, stock: 50,
    description: "Set of six gold-plated bangles with a matte polish finish. Comfort-fit edges for all-day wear.",
    tags: ["bangles", "set", "traditional"], imagePrompt: "stack of gold bangles arranged in a row, " + IMG_STYLE,
  },
  {
    name: "Pearl Drop Earrings", slug: "pearl-drop-earrings", brand: "Aurelia", category: "artificial-jewellery",
    price: 899, comparePrice: 1199, rating: 4.5, reviewCount: 164, stock: 65,
    description: "Freshwater-style pearl drops on gold-plated hooks. Featherlight with secure clasps.",
    tags: ["earrings", "pearl", "drop"], imagePrompt: "pair of pearl drop earrings with gold hooks, " + IMG_STYLE,
  },
  {
    name: "Kundan Bridal Set", slug: "kundan-bridal-set", brand: "Zari", category: "artificial-jewellery",
    price: 3999, comparePrice: 4999, rating: 4.8, reviewCount: 45, stock: 13, featured: true,
    description: "Traditional kundan choker with matching jhumkis and maang tikka. A complete bridal statement set.",
    tags: ["bridal", "kundan", "traditional"], imagePrompt: "ornate gold bridal jewellery set with red stones, " + IMG_STYLE,
  },
  {
    name: "Charm Chain Bracelet", slug: "charm-chain-bracelet", brand: "Aurelia", category: "artificial-jewellery",
    price: 999, rating: 4.2, reviewCount: 88, stock: 58,
    description: "Adjustable chain bracelet with three detachable charms. Layer it or let it shine solo.",
    tags: ["bracelet", "charm", "adjustable"], imagePrompt: "thin gold charm bracelet with small pendants, " + IMG_STYLE,
  },

  // ─── Men's Wallets ───
  {
    name: "Genuine Leather Wallet", slug: "genuine-leather-wallet", brand: "HideCraft", category: "mens-wallets",
    price: 2499, comparePrice: 2999, rating: 4.7, reviewCount: 154, stock: 32, featured: true,
    description: "Full-grain leather bifold with 8 card slots, two currency compartments and an ID window. Ages beautifully.",
    tags: ["leather", "bifold", "genuine"], imagePrompt: "brown genuine leather bifold wallet slightly open, " + IMG_STYLE,
  },
  {
    name: "RFID Slim Wallet", slug: "rfid-slim-wallet", brand: "HideCraft", category: "mens-wallets",
    price: 1899, rating: 4.5, reviewCount: 110, stock: 41,
    description: "Minimalist slim wallet with RFID-blocking lining, quick-access pull tab and space for 6 cards plus cash strap.",
    tags: ["rfid", "slim", "minimal"], imagePrompt: "slim black leather wallet with visible card slots, " + IMG_STYLE,
  },
  {
    name: "Classic Bifold Wallet", slug: "classic-bifold-wallet", brand: "HideCraft", category: "mens-wallets",
    price: 1599, comparePrice: 1999, rating: 4.3, reviewCount: 96, stock: 47,
    description: "Everyday bifold in soft matte leather with contrast stitching. Lightweight yet durable.",
    tags: ["bifold", "classic", "everyday"], imagePrompt: "dark brown leather bifold wallet with stitching detail, " + IMG_STYLE,
  },
  {
    name: "Zip Around Long Wallet", slug: "zip-around-long-wallet", brand: "HideCraft", category: "mens-wallets",
    price: 2199, rating: 4.4, reviewCount: 67, stock: 26,
    description: "Full-zip long wallet with 12 card slots, coin pouch and passport-friendly size. Travel-ready organisation.",
    tags: ["zip", "travel", "long wallet"], imagePrompt: "navy leather long zip-around wallet, " + IMG_STYLE,
  },

  // ─── Perfumes ───
  {
    name: "Noir Intense Eau de Parfum 100ml", slug: "noir-intense-eau-de-parfum", brand: "Maison K", category: "perfumes",
    price: 7999, comparePrice: 9999, rating: 4.8, reviewCount: 142, stock: 18, featured: true,
    description: "A bold woody-amber signature with bergamot top notes, smoky heart and vanilla-tonka base. 10+ hour projection.",
    tags: ["edp", "woody", "evening"], imagePrompt: "luxury black perfume bottle with gold cap, " + IMG_STYLE,
  },
  {
    name: "Bella Vita Luxury Perfume", slug: "bella-vita-luxury-perfume", brand: "Bella Vita", category: "perfumes",
    price: 3499, comparePrice: 3999, rating: 4.5, reviewCount: 176, stock: 27,
    description: "Fresh floral-fruity eau de parfum with jasmine and peach over a musky base. Daytime elegance in a glass flacon.",
    tags: ["floral", "daily", "bella vita"], imagePrompt: "amber glass luxury perfume bottle with pump, " + IMG_STYLE,
  },
  {
    name: "Oud Royal Attar 12ml", slug: "oud-royal-attar", brand: "Al Nuaim", category: "perfumes",
    price: 2999, rating: 4.7, reviewCount: 98, stock: 22,
    description: "Pure concentrated oud attar with deep resinous warmth. Alcohol-free and long-lasting, traditionally distilled.",
    tags: ["attar", "oud", "traditional"], imagePrompt: "small ornate arabic attar bottle with gold detailing, " + IMG_STYLE,
  },
  {
    name: "Fresh Aqua Cologne", slug: "fresh-aqua-cologne", brand: "Maison K", category: "perfumes",
    price: 2499, comparePrice: 2999, rating: 4.3, reviewCount: 87, stock: 35,
    description: "Crisp marine cologne with citrus and sea-salt notes over driftwood. Your everyday refresher.",
    tags: ["cologne", "fresh", "citrus"], imagePrompt: "light blue cologne bottle with silver cap, " + IMG_STYLE,
  },
  {
    name: "Rose Musk Body Mist 250ml", slug: "rose-musk-body-mist", brand: "Bella Vita", category: "perfumes",
    price: 1299, comparePrice: 1599, rating: 4.2, reviewCount: 121, stock: 48,
    description: "Soft rose and white musk body mist with a delicate shimmer finish. Gentle on skin, kind to every plan.",
    tags: ["mist", "rose", "musk"], imagePrompt: "pink body mist spray bottle with rose petals beside it, " + IMG_STYLE,
  },

  // ─── Mobile Accessories ───
  {
    name: "20W PD Fast Charger", slug: "20w-pd-fast-charger", brand: "Anker", category: "mobile-accessories",
    price: 1899, comparePrice: 2499, rating: 4.6, reviewCount: 210, stock: 52,
    description: "USB-C Power Delivery charger that fuels most phones to 50% in 30 minutes. Compact, heat-safe and travel-ready.",
    tags: ["charger", "usb-c", "fast"], imagePrompt: "white compact wall charger with usb-c port, " + IMG_STYLE,
  },
  {
    name: "Power Bank 20000mAh", slug: "power-bank-20000mah", brand: "Baseus", category: "mobile-accessories",
    price: 4999, comparePrice: 5999, rating: 4.7, reviewCount: 167, stock: 24, featured: true,
    description: "22.5W fast-charging power bank with dual USB-A and USB-C ports, digital battery display and airline-safe capacity.",
    tags: ["power bank", "20000mah", "travel"], imagePrompt: "black slim power bank with digital display showing percentage, " + IMG_STYLE,
  },
  {
    name: "Braided USB-C Cable 2m", slug: "braided-usb-c-cable", brand: "Baseus", category: "mobile-accessories",
    price: 599, comparePrice: 799, rating: 4.5, reviewCount: 320, stock: 90,
    description: "Nylon-braided 100W USB-C to USB-C cable tested for 20,000+ bends. Fast data sync and charging.",
    tags: ["cable", "usb-c", "braided"], imagePrompt: "grey braided usb-c charging cable coiled neatly, " + IMG_STYLE,
  },
  {
    name: "Magnetic Car Mount", slug: "magnetic-car-mount", brand: "Spigen", category: "mobile-accessories",
    price: 1499, rating: 4.4, reviewCount: 88, stock: 38,
    description: "Strong N52-magnet vent mount with 360° rotation and one-hand docking. Holds phones steady on any road.",
    tags: ["car mount", "magnetic", "vent"], imagePrompt: "black magnetic car phone mount attached to air vent, " + IMG_STYLE,
  },
  {
    name: "Wireless Charging Pad 15W", slug: "wireless-charging-pad-15w", brand: "Anker", category: "mobile-accessories",
    price: 2499, comparePrice: 2999, rating: 4.5, reviewCount: 76, stock: 29,
    description: "Qi-certified 15W wireless pad with case-friendly charging, anti-slip ring and smart temperature control.",
    tags: ["wireless", "qi", "15w"], imagePrompt: "round white wireless charging pad with phone charging on it, " + IMG_STYLE,
  },

  // ─── Couple Watches ───
  {
    name: "His & Hers Couple Watch Set", slug: "his-hers-couple-watch-set", brand: "Curren", category: "couple-watches",
    price: 7999, comparePrice: 9999, rating: 4.7, reviewCount: 89, stock: 14, featured: true,
    description: "Matching pair of analog watches with silver cases, white dials and mesh straps — one 40mm, one 32mm. Gift-boxed.",
    tags: ["couple", "set", "gift"], imagePrompt: "pair of matching silver couple wrist watches side by side, " + IMG_STYLE,
  },
  {
    name: "Rose Gold Matching Pair", slug: "rose-gold-matching-pair", brand: "Naviforce", category: "couple-watches",
    price: 6499, rating: 4.5, reviewCount: 62, stock: 17,
    description: "Rose-gold duo with slim profiles and cream dials. A romantic gift that arrives ready to give.",
    tags: ["rose gold", "couple", "romantic"], imagePrompt: "rose gold couple watches pair with cream dials, " + IMG_STYLE,
  },
  {
    name: "Classic Black Duo Set", slug: "classic-black-duo-set", brand: "Curren", category: "couple-watches",
    price: 5999, comparePrice: 6999, rating: 4.4, reviewCount: 51, stock: 19,
    description: "Black-dial pair with leather straps — a bold 42mm for him and an elegant 34mm for her. Quartz accuracy.",
    tags: ["black", "leather", "duo"], imagePrompt: "black dial couple watches with brown leather straps, " + IMG_STYLE,
  },
];
