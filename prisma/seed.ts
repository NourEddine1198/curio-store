import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaNeonHttp } from "@prisma/adapter-neon";

const adapter = new PrismaNeonHttp(process.env.DATABASE_URL!, { arrayMode: false, fullResults: true });
const prisma = new PrismaClient({ adapter });

async function main() {
  // ─── Products ───────────────────────────────────────────
  await prisma.product.upsert({
    where: { slug: "goul-bla-matgoul" },
    update: {},
    create: {
      slug: "goul-bla-matgoul",
      name: "قول بلا متقول",
      nameEn: "Goul Bla Matgoul (Algerian Taboo)",
      description:
        "وصّف الكلمة بلا ما تقول الكلمات الممنوعة. أول لعبة تابو بالدارجة الجزائرية.",
      price: 2390,
      stock: 500,
      images: [],
      active: true,
    },
  });

  await prisma.product.upsert({
    where: { slug: "roubla" },
    update: {},
    create: {
      slug: "roubla",
      name: "روبلة",
      nameEn: "Roubla (Algerian Speedbac)",
      description:
        "لعبة السرعة — لقا كلمة تبدا بالحرف لي طاحلك على حسب الكاتيغوري. بالدارجة الجزائرية.",
      price: 2390,
      stock: 500,
      images: [],
      active: true,
    },
  });

  await prisma.product.upsert({
    where: { slug: "eid-2026-bundle" },
    update: {},
    create: {
      slug: "eid-2026-bundle",
      name: "باك العيد 2026",
      nameEn: "Eid 2026 Bundle (Goul + Roubla)",
      description:
        "روبلة + قول بلا متقول مع بعض. أحسن كادو للعيد بسعر خاص.",
      price: 3900,
      compareAt: 4780,
      stock: 250,
      images: [],
      active: true,
    },
  });

  console.log("✓ Products seeded (3 products)");

  // ─── All 58 Wilayas with real delivery prices ──────────
  // Source: assets/custom-code.js DELIVERY_DATA array (ZR Express prices)
  // home/office = null means delivery not available to that wilaya
  const wilayas: {
    code: string;
    name: string;
    homePrice: number;
    officePrice: number;
    offices: unknown;
    active: boolean;
  }[] = [
    {
      code: "01",
      name: "أدرار",
      homePrice: 1650,
      officePrice: 850,
      offices: [{ station: "Station Adrar", commune: "Adrar", phone: ["0660709353"] }],
      active: true,
    },
    {
      code: "02",
      name: "الشلف",
      homePrice: 700,
      officePrice: 450,
      offices: [{ station: "Station Chlef", commune: "Chlef", phone: ["0770511166", "0670675881"] }],
      active: true,
    },
    {
      code: "03",
      name: "الأغواط",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Laghouat", commune: "Laghouat", phone: [] },
        { station: "Station Laghouat New", commune: "Laghouat", phone: ["0770953193"] },
      ],
      active: true,
    },
    {
      code: "04",
      name: "أم البواقي",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Oum El Bouaghi", commune: "Oum El Bouaghi", phone: ["0660877228", "0660128008"] },
        { station: "Station Ain Fekroune", commune: "Ain Fekroune", phone: [] },
        { station: "Station Aïn M'lila", commune: "Ain M'lila", phone: ["0770531702"] },
      ],
      active: true,
    },
    {
      code: "05",
      name: "باتنة",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Batna - Cité El Amrani", commune: "Oued Chaaba", phone: ["0770531028"] },
        { station: "Station Batna", commune: "Batna", phone: ["0770637788", "0770518901"] },
      ],
      active: true,
    },
    {
      code: "06",
      name: "بجاية",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Béjaïa - Akbou", commune: "Akbou", phone: ["0550295278", "0770807317"] },
        { station: "Station Béjaïa", commune: "Bejaia", phone: ["0560250529", "0770753564"] },
        { station: "Station El Kseur", commune: "El Kseur", phone: ["0560817050"] },
      ],
      active: true,
    },
    {
      code: "07",
      name: "بسكرة",
      homePrice: 850,
      officePrice: 650,
      offices: [{ station: "Station Biskra", commune: "Biskra", phone: ["0770522149"] }],
      active: true,
    },
    {
      code: "08",
      name: "بشار",
      homePrice: 1200,
      officePrice: 650,
      offices: [{ station: "Station Béchar", commune: "Bechar", phone: ["0671559677"] }],
      active: true,
    },
    {
      code: "09",
      name: "البليدة",
      homePrice: 650,
      officePrice: 400,
      offices: [
        { station: "Station Blida - Boufarik", commune: "Boufarik", phone: ["0770808317"] },
        { station: "Station Blida", commune: "Blida", phone: ["0784602779", "0770967048"] },
      ],
      active: true,
    },
    {
      code: "10",
      name: "البويرة",
      homePrice: 650,
      officePrice: 450,
      offices: [{ station: "Station Bouira", commune: "Bouira", phone: ["0770780702"] }],
      active: true,
    },
    {
      code: "11",
      name: "تمنراست",
      homePrice: 1800,
      officePrice: 1000,
      offices: [{ station: "Station Tamanrasset", commune: "Tamanrasset", phone: ["0770780713"] }],
      active: true,
    },
    {
      code: "12",
      name: "تبسة",
      homePrice: 850,
      officePrice: 450,
      offices: [{ station: "Station Tébessa", commune: "Tebessa", phone: ["0770507961"] }],
      active: true,
    },
    {
      code: "13",
      name: "تلمسان",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Maghnia", commune: "Maghnia", phone: ["0770845020"] },
        { station: "Station Tlemcen", commune: "Tlemcen", phone: ["0770451113"] },
      ],
      active: true,
    },
    {
      code: "14",
      name: "تيارت",
      homePrice: 850,
      officePrice: 450,
      offices: [{ station: "Station Tiaret", commune: "Tiaret", phone: ["0770750979"] }],
      active: true,
    },
    {
      code: "15",
      name: "تيزي وزو",
      homePrice: 650,
      officePrice: 450,
      offices: [
        { station: "Station Tizi Ouzou", commune: "Tizi Ouzou", phone: ["0795006815"] },
        { station: "Station Azazga", commune: "Tizi Ouzou", phone: ["0770898601"] },
        { station: "Station Tizi Ouzou Nouvelle Ville", commune: "Tizi Ouzou", phone: ["0563009791"] },
        { station: "Station Boghni", commune: "Boghni", phone: ["0563009792"] },
      ],
      active: true,
    },
    {
      code: "16",
      name: "الجزائر",
      homePrice: 450,
      officePrice: 300,
      offices: [
        { station: "Station Alger Ain Naadja", commune: "Djasr Kasentina", phone: ["0770531704"] },
        { station: "Station Alger Draria", commune: "Draria", phone: ["0771110157", "0770808759"] },
        { station: "Station Alger Ain Benian", commune: "Ain Benian", phone: ["0770530775"] },
        { station: "Station Alger Bab El Oued", commune: "Bab El Oued", phone: ["0770845062"] },
        { station: "Station Alger Sacré Coeur", commune: "Alger Centre", phone: ["0770898643"] },
        { station: "Station Alger Reghaia", commune: "Reghaia", phone: ["0770012586"] },
        { station: "Station Alger Eucalyptus", commune: "Les Eucalyptus", phone: ["0770163989"] },
        { station: "Station Alger Dely Brahim", commune: "Dely Ibrahim", phone: ["0770530923"] },
        { station: "Station Alger Oued Smar", commune: "Oued Smar", phone: ["0770118225"] },
        { station: "Station Alger Cheraga", commune: "Cheraga", phone: ["0563009787"] },
        { station: "Station Alger Kouba", commune: "Kouba", phone: ["0770486105"] },
      ],
      active: true,
    },
    {
      code: "17",
      name: "الجلفة",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Djelfa", commune: "Djelfa", phone: ["0770753611"] },
        { station: "Station Djelfa - Ain Oussera", commune: "Ain Oussera", phone: ["0770953266"] },
      ],
      active: true,
    },
    {
      code: "18",
      name: "جيجل",
      homePrice: 850,
      officePrice: 450,
      offices: [{ station: "Station Jijel", commune: "Jijel", phone: ["0770976207"] }],
      active: true,
    },
    {
      code: "19",
      name: "سطيف",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Sétif - El Eulma", commune: "El Eulma", phone: ["0770521261"] },
        { station: "Station Ain Azel", commune: "Ain Azel", phone: ["0770899367"] },
        { station: "Station Sétif - Cité Bouaroua", commune: "Setif", phone: ["0770898787"] },
        { station: "Station Sétif El Hidab", commune: "Setif", phone: ["0770751080", "0771823802"] },
        { station: "Station Sétif - Ain Oulmene", commune: "Ain Oulmane", phone: ["0770751081"] },
      ],
      active: true,
    },
    {
      code: "20",
      name: "سعيدة",
      homePrice: 850,
      officePrice: 450,
      offices: [{ station: "Station Saïda", commune: "Saida", phone: ["0770751017"] }],
      active: true,
    },
    {
      code: "21",
      name: "سكيكدة",
      homePrice: 850,
      officePrice: 450,
      offices: [{ station: "Station Skikda", commune: "Skikda", phone: ["0770451085"] }],
      active: true,
    },
    {
      code: "22",
      name: "سيدي بلعباس",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Telagh", commune: "Telagh", phone: ["0770164534"] },
        { station: "Station Sidi Bel Abbès", commune: "Sidi Bel Abbes", phone: ["0770486538"] },
      ],
      active: true,
    },
    {
      code: "23",
      name: "عنابة",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Annaba", commune: "Annaba", phone: ["0561869178", "0770451061"] },
        { station: "Station Annaba El Bouni", commune: "El Bouni", phone: ["0770773406", "0770336039"] },
      ],
      active: true,
    },
    {
      code: "24",
      name: "قالمة",
      homePrice: 850,
      officePrice: 450,
      offices: [{ station: "Station Guelma", commune: "Guelma", phone: ["0772421972", "0770520817"] }],
      active: true,
    },
    {
      code: "25",
      name: "قسنطينة",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Constantine - Ali Mendjeli", commune: "El Khroub", phone: ["0770911838"] },
        { station: "Station Constantine - Sidi Mebrouk", commune: "Didouche Mourad", phone: ["0770797329"] },
      ],
      active: true,
    },
    {
      code: "26",
      name: "المدية",
      homePrice: 650,
      officePrice: 450,
      offices: [{ station: "Station Médéa", commune: "Medea", phone: ["0770797168", "0770091207"] }],
      active: true,
    },
    {
      code: "27",
      name: "مستغانم",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Mostaganem 2", commune: "Mostaganem", phone: ["0770845070"] },
        { station: "Station Mostaganem", commune: "Hadjadj", phone: ["0770371420"] },
      ],
      active: true,
    },
    {
      code: "28",
      name: "المسيلة",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station M'Sila New", commune: "M'sila", phone: ["0770164280"] },
        { station: "Station M'Sila", commune: "M'Sila", phone: [] },
        { station: "Station Boussaâda", commune: "Bou Saada", phone: ["0778979623"] },
      ],
      active: true,
    },
    {
      code: "29",
      name: "معسكر",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Mascara - Sig", commune: "Sig", phone: ["0770797163"] },
        { station: "Station Mascara", commune: "Mascara", phone: ["0770775964"] },
      ],
      active: true,
    },
    {
      code: "30",
      name: "ورقلة",
      homePrice: 1000,
      officePrice: 500,
      offices: [
        { station: "Station Ouargla", commune: "Ouargla", phone: ["0661186606"] },
        { station: "Station Ouargla - Hassi Messaoud", commune: "Hassi Messaoud", phone: ["0674273120"] },
      ],
      active: true,
    },
    {
      code: "31",
      name: "وهران",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Oran Es Senia (Maraval)", commune: "Es Senia", phone: ["0770898647", "0770898629"] },
        { station: "Station Oran - Hai Sabah", commune: "Bir El Djir", phone: ["0770753696"] },
        { station: "Station Oran Khemisti", commune: "Mers El Kebir", phone: ["0770163993", "0770164228"] },
        { station: "Station Oran Gambetta", commune: "Oran", phone: ["0770911476"] },
      ],
      active: true,
    },
    {
      code: "32",
      name: "البيض",
      homePrice: 850,
      officePrice: 450,
      offices: [{ station: "Station El Bayadh", commune: "El Bayadh", phone: ["0675265384"] }],
      active: true,
    },
    {
      code: "33",
      name: "إليزي",
      homePrice: 0,
      officePrice: 0,
      offices: [
        { station: "Station Illizi", commune: "Illizi", phone: ["0791917907"] },
        { station: "Station In Amenas", commune: "In Amenas", phone: ["0658305407"] },
      ],
      active: false, // No delivery prices available
    },
    {
      code: "34",
      name: "برج بوعريريج",
      homePrice: 650,
      officePrice: 450,
      offices: [{ station: "Station Bordj Bou Arreridj", commune: "Bordj Bou Arreridj", phone: ["0675553122"] }],
      active: true,
    },
    {
      code: "35",
      name: "بومرداس",
      homePrice: 650,
      officePrice: 400,
      offices: [
        { station: "Station Boumerdès", commune: "Boumerdes", phone: ["0770912531", "0770898605"] },
        { station: "Station Bordj Menaiel", commune: "Bordj Menaiel", phone: ["0770772556"] },
        { station: "Station Dellys", commune: "Dellys", phone: ["0770912056"] },
      ],
      active: true,
    },
    {
      code: "36",
      name: "الطارف",
      homePrice: 850,
      officePrice: 550,
      offices: [
        { station: "Station El Tarf", commune: "El Tarf", phone: [] },
        { station: "Station El Tarf New", commune: "El Tarf", phone: ["0652668097", "0770936164"] },
      ],
      active: true,
    },
    {
      code: "37",
      name: "تندوف",
      homePrice: 1650,
      officePrice: 700,
      offices: [],
      active: true,
    },
    {
      code: "38",
      name: "تيسمسيلت",
      homePrice: 850,
      officePrice: 450,
      offices: [{ station: "Station Tissemsilt", commune: "Tissemsilt", phone: ["0672852152"] }],
      active: true,
    },
    {
      code: "39",
      name: "الوادي",
      homePrice: 950,
      officePrice: 600,
      offices: [{ station: "Station El Oued", commune: "El Oued", phone: ["0654707097", "0770771833"] }],
      active: true,
    },
    {
      code: "40",
      name: "خنشلة",
      homePrice: 850,
      officePrice: 450,
      offices: [{ station: "Station Khenchela", commune: "Khenchela", phone: ["0770521072"] }],
      active: true,
    },
    {
      code: "41",
      name: "سوق أهراس",
      homePrice: 850,
      officePrice: 450,
      offices: [{ station: "Station Souk Ahras", commune: "Souk Ahras", phone: ["0770776689"] }],
      active: true,
    },
    {
      code: "42",
      name: "تيبازة",
      homePrice: 650,
      officePrice: 450,
      offices: [
        { station: "Station Koléa", commune: "Kolea", phone: ["0770912305"] },
        { station: "Station Tipaza", commune: "Tipaza", phone: ["0770797338"] },
        { station: "Station Hadjout", commune: "Hadjout", phone: ["0770807997"] },
      ],
      active: true,
    },
    {
      code: "43",
      name: "ميلة",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Chelghoum Laïd", commune: "Chelghoum Laid", phone: ["0770898639"] },
        { station: "Station Mila", commune: "Mila", phone: ["0770738712"] },
      ],
      active: true,
    },
    {
      code: "44",
      name: "عين الدفلى",
      homePrice: 650,
      officePrice: 450,
      offices: [{ station: "Station Aïn Defla", commune: "Ain Defla", phone: ["0770780589"] }],
      active: true,
    },
    {
      code: "45",
      name: "النعامة",
      homePrice: 950,
      officePrice: 500,
      offices: [{ station: "Station Naâma - Mechria", commune: "Mecheria", phone: ["0668426646"] }],
      active: true,
    },
    {
      code: "46",
      name: "عين تموشنت",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Aïn Témouchent - Beni Saf", commune: "Beni Saf", phone: ["0770797349"] },
        { station: "Station Aïn Témouchent", commune: "Ain Temouchent", phone: ["0770868817"] },
      ],
      active: true,
    },
    {
      code: "47",
      name: "غرداية",
      homePrice: 950,
      officePrice: 650,
      offices: [{ station: "Station Ghardaïa", commune: "Ghardaia", phone: ["0770531062", "0770531289"] }],
      active: true,
    },
    {
      code: "48",
      name: "غليزان",
      homePrice: 850,
      officePrice: 450,
      offices: [
        { station: "Station Oued Rhiou", commune: "Oued Rhiou", phone: ["0770899295"] },
        { station: "Station Relizane", commune: "Relizane", phone: ["0770783044"] },
      ],
      active: true,
    },
    {
      code: "49",
      name: "تيميمون",
      homePrice: 1650,
      officePrice: 850,
      offices: [],
      active: true,
    },
    {
      code: "50",
      name: "برج باجي مختار",
      homePrice: 2000,
      officePrice: 1200,
      offices: [],
      active: true,
    },
    {
      code: "51",
      name: "أولاد جلال",
      homePrice: 950,
      officePrice: 450,
      offices: [{ station: "Station Ouled Djellal", commune: "Ouled Djellal", phone: ["0550576439", "0555132822"] }],
      active: true,
    },
    {
      code: "52",
      name: "بني عباس",
      homePrice: 1300,
      officePrice: 650,
      offices: [],
      active: true,
    },
    {
      code: "53",
      name: "عين صالح",
      homePrice: 1650,
      officePrice: 850,
      offices: [{ station: "Station In Salah", commune: "In Salah", phone: ["0670152552", "0554006696"] }],
      active: true,
    },
    {
      code: "54",
      name: "عين قزام",
      homePrice: 2000,
      officePrice: 1200,
      offices: [],
      active: true,
    },
    {
      code: "55",
      name: "تقرت",
      homePrice: 950,
      officePrice: 500,
      offices: [{ station: "Station Touggourt", commune: "Touggourt", phone: ["0770999634", "0697052872"] }],
      active: true,
    },
    {
      code: "56",
      name: "جانت",
      homePrice: 0,
      officePrice: 0,
      offices: [
        { station: "Station Djanet", commune: "Djanet", phone: ["0698502737"] },
        { station: "Station Djanet New", commune: "Djanet", phone: ["0698502737"] },
      ],
      active: false, // No delivery prices available
    },
    {
      code: "57",
      name: "المغير",
      homePrice: 950,
      officePrice: 500,
      offices: [{ station: "Station El M'Ghair", commune: "El M'ghair", phone: ["0770898640"] }],
      active: true,
    },
    {
      code: "58",
      name: "المنيعة",
      homePrice: 950,
      officePrice: 500,
      offices: [],
      active: true,
    },
  ];

  for (const w of wilayas) {
    await prisma.wilaya.upsert({
      where: { code: w.code },
      update: { name: w.name, homePrice: w.homePrice, officePrice: w.officePrice, offices: w.offices, active: w.active },
      create: w,
    });
  }

  console.log(`✓ ${wilayas.length} wilayas seeded (all 58 Algerian wilayas)`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
