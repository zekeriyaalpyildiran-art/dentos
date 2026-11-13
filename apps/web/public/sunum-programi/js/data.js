/* =========================================================
   Katalog: tedaviler, bulgular, fazlar, diş düzeni
   ========================================================= */

const PHASES = {
  1: { name: 'Temel Tedaviler', desc: 'Ağrı, enfeksiyon ve çürüklerin giderilmesi', color: '#3aa6b9' },
  2: { name: 'Cerrahi Aşama', desc: 'Çekim, implant ve kemik işlemleri', color: '#e0864a' },
  3: { name: 'Protetik & Estetik', desc: 'Kalıcı dişler, kaplamalar ve gülüş tasarımı', color: '#7b6cf6' },
  4: { name: 'Koruma & Bakım', desc: 'Sonucun uzun ömürlü olması için', color: '#43a26b' }
};

/* scope: tooth = dişe tıklanır, multi = birden fazla diş (köprü), quad = yarım çene (bölge),
          arch = çene (üst/alt), mouth = tüm ağız
   group: düzenleyicideki işlem grubu · base: tedavi sonrası görünümde hangi temel işlem gibi çizilir
   after: çene/köprü bazlı tedavi sonrası görünüm (fixedArch, removableArch, partial, pontic)
   Fiyatlar: Macro fiyat listesi, 13.11.2026 */
const PRICE_LIST = 'macro-2026-11-13';
const TX = {
  detartraj: {
    name: 'Diş Taşı Temizliği (Detartraj)', abbr: 'TMZ', scope: 'arch', phase: 1, price: 4500, group: 'temel',
    sessions: '1 seans', duration: '30–45 dk', color: '#3fb3c4', anim: 'detartraj',
    desc: 'Diş yüzeylerinde ve diş eti çizgisinde biriken diş taşı (tartar), ultrasonik uçlarla nazikçe temizlenir ve yüzeyler cilalanır. Fiyat çene başına hesaplanır.',
    benefits: ['Diş eti kanaması ve iltihabı azalır', 'Ağız kokusunun önüne geçilir', 'Diğer tedaviler sağlıklı bir zeminde başlar']
  },
  airflow: {
    name: 'Airflow (Hava-Toz ile Temizlik)', abbr: 'AFL', scope: 'mouth', phase: 1, price: 3000, group: 'temel',
    sessions: '1 seans', duration: '30–45 dk', color: '#4fc3d9', anim: 'detartraj',
    desc: 'Su, hava ve ince toz karışımıyla diş yüzeylerindeki lekeler ve bakteri plağı nazikçe temizlenir; dişler pürüzsüz ve parlak hale gelir.',
    benefits: ['Çay, kahve ve sigara lekeleri azalır', 'Diş eti çizgisi ve ara yüzler etkili temizlenir', 'Konforlu, ağrısız uygulama']
  },
  kuretaj: {
    name: 'Diş Eti Tedavisi (Subgingival Küretaj)', abbr: 'KÜR', scope: 'quad', phase: 1, price: 5000, group: 'temel',
    sessions: '1–2 seans', duration: 'Seans başı 45–60 dk', color: '#e0607e', anim: 'kuretaj',
    desc: 'Diş eti cebinin derinlerinde, kök yüzeyine yapışmış birikintiler ve iltihaplı doku temizlenir. Diş eti yeniden dişe sıkıca tutunur. Fiyat bölge (yarım çene) başına hesaplanır.',
    benefits: ['Diş kaybının en önemli nedeni olan diş eti hastalığı durdurulur', 'Sallanma riski azalır', 'Diş eti sağlıklı pembe rengine kavuşur']
  },
  dolgu: {
    name: 'Kompozit Dolgu', abbr: 'DLG', scope: 'tooth', phase: 1, price: 5000, group: 'temel',
    sessions: '1 seans', duration: '30–45 dk / diş', color: '#4f8ef7', anim: 'dolgu',
    desc: 'Çürük doku temizlenir, diş kendi renginde kompozit malzemeyle katman katman doldurulur ve özel ışıkla sertleştirilir.',
    benefits: ['Diş renginde, fark edilmeyen sonuç', 'Çürüğün ilerlemesi durdurulur', 'Diş dokusu maksimum korunur']
  },
  kanal: {
    name: 'Kanal Tedavisi (1 Kanal)', abbr: 'KNL', scope: 'tooth', phase: 1, price: 9000, group: 'temel',
    sessions: '1–2 seans', duration: '60–90 dk / seans', color: '#e94f4f', anim: 'kanal',
    desc: 'İltihaplanmış sinir dokusu temizlenir, kanallar dezenfekte edilip kalıcı olarak doldurulur. Diş çekilmeden ağızda kalır.',
    benefits: ['Ağrı ve enfeksiyon ortadan kalkar', 'Doğal diş korunur, çekime gerek kalmaz', 'Modern yöntemlerle konforlu işlem']
  },
  kanal2: {
    name: 'Kanal Tedavisi (2 Kanal)', abbr: 'KN2', scope: 'tooth', phase: 1, price: 10000, group: 'temel', base: 'kanal',
    sessions: '1–2 seans', duration: '60–90 dk / seans', color: '#d84343', anim: 'kanal',
    desc: 'İltihaplanmış sinir dokusu temizlenir, kanallar dezenfekte edilip kalıcı olarak doldurulur. Diş çekilmeden ağızda kalır.',
    benefits: ['Ağrı ve enfeksiyon ortadan kalkar', 'Doğal diş korunur, çekime gerek kalmaz', 'Modern yöntemlerle konforlu işlem']
  },
  kanal3: {
    name: 'Kanal Tedavisi (3 Kanal)', abbr: 'KN3', scope: 'tooth', phase: 1, price: 11500, group: 'temel', base: 'kanal',
    sessions: '1–2 seans', duration: '60–90 dk / seans', color: '#c13838', anim: 'kanal',
    desc: 'İltihaplanmış sinir dokusu temizlenir, kanallar dezenfekte edilip kalıcı olarak doldurulur. Diş çekilmeden ağızda kalır.',
    benefits: ['Ağrı ve enfeksiyon ortadan kalkar', 'Doğal diş korunur, çekime gerek kalmaz', 'Modern yöntemlerle konforlu işlem']
  },
  kronSokumu: {
    name: 'Eski Kron / Köprü Sökümü', abbr: 'SÖK', scope: 'tooth', phase: 1, price: 1700, group: 'temel',
    sessions: '1 seans', duration: '15–30 dk / üye', color: '#90a4ae', anim: 'generic',
    desc: 'Uyumsuz veya eskimiş kron ve köprüler, alttaki dişe zarar vermeden dikkatle çıkarılır; dişler yeni tedaviye hazırlanır. Fiyat üye (diş) başına hesaplanır.',
    benefits: ['Alttaki dişlerin durumu değerlendirilebilir', 'Yeni restorasyon için temiz bir başlangıç', 'Çürük ve sızıntıların önüne geçilir']
  },
  cekim: {
    name: 'Diş Çekimi', abbr: 'ÇKM', scope: 'tooth', phase: 2, price: 4500, group: 'cerrahi',
    sessions: '1 seans', duration: '20–40 dk', color: '#8d6e63', anim: 'cekim',
    desc: 'Kurtarılması mümkün olmayan diş, lokal anestezi altında çevre dokular korunarak nazikçe çıkarılır.',
    benefits: ['Enfeksiyon kaynağı ortadan kalkar', 'Komşu dişler ve kemik korunur', 'Yeni diş için sağlıklı zemin hazırlanır']
  },
  cekimKomplike: {
    name: 'Komplikasyonlu Diş Çekimi', abbr: 'ÇKK', scope: 'tooth', phase: 2, price: 6500, group: 'cerrahi', base: 'cekim',
    sessions: '1 seans', duration: '30–60 dk', color: '#795548', anim: 'cekim',
    desc: 'Kökleri kıvrık, kırık veya kemiğe kaynaşmış dişler, lokal anestezi altında kontrollü cerrahi yöntemlerle çıkarılır.',
    benefits: ['Enfeksiyon kaynağı ortadan kalkar', 'Çevre doku ve kemik korunur', 'Yeni tedavi için sağlıklı zemin hazırlanır']
  },
  gomulu: {
    name: 'Gömülü Diş Operasyonu', abbr: 'GÖM', scope: 'tooth', phase: 2, price: 10000, group: 'cerrahi', base: 'cekim',
    sessions: '1 seans', duration: '30–60 dk', color: '#8e24aa', anim: 'cekim',
    desc: 'Diş eti veya çene kemiği içinde kalmış (gömülü) diş, lokal anestezi altında küçük bir cerrahi işlemle çıkarılır.',
    benefits: ['Ağrı, şişlik ve enfeksiyon riski ortadan kalkar', 'Komşu dişler korunur', 'Kist oluşumunun önüne geçilir']
  },
  gomuluKemik: {
    name: 'Gömülü Diş Operasyonu (Kemik İçinde)', abbr: 'GÖK', scope: 'tooth', phase: 2, price: 12500, group: 'cerrahi', base: 'cekim',
    sessions: '1 seans', duration: '45–90 dk', color: '#6a1b9a', anim: 'cekim',
    desc: 'Tamamen kemik içinde kalmış gömülü diş, çevredeki kemik ve sinir yapıları korunarak cerrahi olarak çıkarılır.',
    benefits: ['Ağrı, şişlik ve enfeksiyon riski ortadan kalkar', 'Komşu dişler korunur', 'Kist oluşumunun önüne geçilir']
  },
  greft: {
    name: 'Kemik Grefti', abbr: 'GRF', scope: 'tooth', phase: 2, price: 8000, group: 'cerrahi',
    sessions: '1 seans', duration: '4–6 ay iyileşme', color: '#c9a227', anim: 'greft',
    desc: 'Kemik kaybı olan bölgeye kemik tozu yerleştirilir ve koruyucu bir zarla örtülür. Zamanla yeni kemik oluşur.',
    benefits: ['İmplant için yeterli kemik hacmi sağlanır', 'Yüz ve diş eti desteği korunur', 'Uzun vadeli estetik sonuç']
  },
  membran: {
    name: 'Membran (Koruyucu Zar)', abbr: 'MBR', scope: 'tooth', phase: 2, price: 6000, group: 'cerrahi',
    sessions: '1 seans', duration: 'Greftle birlikte', color: '#d4b44a', anim: 'greft',
    desc: 'Kemik grefti uygulanan bölge, yeni kemik oluşurken dışarıdan doku girişini engelleyen koruyucu bir zarla (membran) örtülür.',
    benefits: ['Greftin yerinde kalmasına yardımcı olur', 'Daha öngörülebilir kemik oluşumu', 'İmplant için güçlü zemin']
  },
  sinus: {
    name: 'Sinüs Lifting', abbr: 'SNS', scope: 'tooth', phase: 2, price: 15000, group: 'cerrahi',
    sessions: '1 seans', duration: '4–6 ay iyileşme', color: '#5e9fd6', anim: 'sinus',
    desc: 'Üst arka bölgede sinüs boşluğu nedeniyle kemik yetersizse, sinüs zarı nazikçe kaldırılır ve altına kemik grefti yerleştirilir.',
    benefits: ['Üst çene arka bölgeye implant yapılabilir hale gelir', 'İmplant uzun ve güçlü kemikte durur', 'Kalıcı ve güvenilir çözüm']
  },
  kronBoyUzatma: {
    name: 'Kuron Boyu Uzatma', abbr: 'KBU', scope: 'tooth', phase: 2, price: 6000, group: 'cerrahi',
    sessions: '1 seans', duration: '30–60 dk', color: '#e57373', anim: 'generic',
    desc: 'Diş eti ve gerekirse kemik seviyesi düzenlenerek dişin görünen kısmı uzatılır; kısa veya diş eti hizasında kırılmış dişler kron yapımına uygun hale gelir, gülüş hattı dengelenir.',
    benefits: ['Kron ve dolgular için sağlam zemin', 'Daha dengeli diş eti ve gülüş hattı', 'Uzun ömürlü restorasyon']
  },
  implantCikarma: {
    name: 'İmplant Çıkarılması', abbr: 'İÇK', scope: 'tooth', phase: 2, price: 10000, group: 'cerrahi',
    sessions: '1 seans', duration: '30–60 dk', color: '#78909c', anim: 'generic',
    desc: 'Başarısız, enfekte veya yanlış konumlanmış implant, çevredeki kemik korunarak çıkarılır; bölge yeni tedaviye hazırlanır.',
    benefits: ['Enfeksiyon kaynağı ortadan kalkar', 'Kemik dokusu korunur', 'Yeni implant için zemin hazırlanır']
  },
  implantRehberi: {
    name: 'Cerrahi Rehber (Tam Çene)', abbr: 'REH', scope: 'arch', phase: 2, price: 4730, group: 'implant',
    sessions: 'Cerrahi öncesi', duration: '3–5 gün üretim', color: '#5c6bc0', anim: 'generic',
    desc: 'Tomografi ve dijital ölçü üzerinden implant konumları bilgisayarda planlanır; bu plana göre üretilen cerrahi rehber, implantların planlanan açı ve derinlikte yerleştirilmesini sağlar.',
    benefits: ['Planlanan konuma hassas yerleştirme', 'Daha kısa ve konforlu cerrahi', 'Protezle uyumlu implant konumları']
  },
  implantRehberiYarim: {
    name: 'Cerrahi Rehber (Yarım Çene)', abbr: 'RHY', scope: 'quad', phase: 2, price: 3265, group: 'implant',
    sessions: 'Cerrahi öncesi', duration: '3–5 gün üretim', color: '#7986cb', anim: 'generic',
    desc: 'Tomografi ve dijital ölçü üzerinden implant konumları bilgisayarda planlanır; bu plana göre üretilen cerrahi rehber, implantların planlanan açı ve derinlikte yerleştirilmesini sağlar.',
    benefits: ['Planlanan konuma hassas yerleştirme', 'Daha kısa ve konforlu cerrahi', 'Protezle uyumlu implant konumları']
  },
  implant: {
    name: 'Neodent İmplant', abbr: 'İMP', scope: 'tooth', phase: 2, price: 400, cur: 'EUR', group: 'implant',
    sessions: '1 seans + iyileşme', duration: '2–4 ay kaynaşma', color: '#607d8b', anim: 'implant',
    desc: 'Eksik dişin yerine çene kemiğine Neodent marka titanyum bir yapay kök yerleştirilir. Kemikle kaynaştıktan sonra üzerine kalıcı diş yapılır.',
    benefits: ['Komşu dişlere dokunulmaz', 'Doğal diş gibi çiğneme hissi', 'Kemik erimesini yavaşlatır']
  },
  implantStraumann: {
    name: 'Straumann ITI İmplant', abbr: 'STR', scope: 'tooth', phase: 2, price: 800, cur: 'EUR', group: 'implant', base: 'implant',
    sessions: '1 seans + iyileşme', duration: '2–4 ay kaynaşma', color: '#546e7a', anim: 'implant',
    desc: 'Eksik dişin yerine çene kemiğine Straumann marka titanyum bir yapay kök yerleştirilir. Kemikle kaynaştıktan sonra üzerine kalıcı diş yapılır.',
    benefits: ['Komşu dişlere dokunulmaz', 'Doğal diş gibi çiğneme hissi', 'Kemik erimesini yavaşlatır']
  },
  implantBLX: {
    name: 'Straumann BLX İmplant', abbr: 'BLX', scope: 'tooth', phase: 2, price: 1100, cur: 'EUR', group: 'implant', base: 'implant',
    sessions: '1 seans + iyileşme', duration: '2–4 ay kaynaşma', color: '#455a64', anim: 'implant',
    desc: 'Eksik dişin yerine çene kemiğine Straumann BLX marka titanyum bir yapay kök yerleştirilir. Kemikle kaynaştıktan sonra üzerine kalıcı diş yapılır.',
    benefits: ['Komşu dişlere dokunulmaz', 'Doğal diş gibi çiğneme hissi', 'Kemik erimesini yavaşlatır']
  },
  implantMedentika: {
    name: 'Medentika İmplant', abbr: 'MDT', scope: 'tooth', phase: 2, price: 800, cur: 'EUR', group: 'implant', base: 'implant',
    sessions: '1 seans + iyileşme', duration: '2–4 ay kaynaşma', color: '#6d8a96', anim: 'implant',
    desc: 'Eksik dişin yerine çene kemiğine Medentika marka titanyum bir yapay kök yerleştirilir. Kemikle kaynaştıktan sonra üzerine kalıcı diş yapılır.',
    benefits: ['Komşu dişlere dokunulmaz', 'Doğal diş gibi çiğneme hissi', 'Kemik erimesini yavaşlatır']
  },
  implantEvos: {
    name: 'Evos (Yerli) İmplant', abbr: 'EVS', scope: 'tooth', phase: 2, price: 15000, group: 'implant', base: 'implant',
    sessions: '1 seans + iyileşme', duration: '2–4 ay kaynaşma', color: '#7d97a3', anim: 'implant',
    desc: 'Eksik dişin yerine çene kemiğine yerli üretim Evos marka titanyum bir yapay kök yerleştirilir. Kemikle kaynaştıktan sonra üzerine kalıcı diş yapılır.',
    benefits: ['Komşu dişlere dokunulmaz', 'Doğal diş gibi çiğneme hissi', 'Kemik erimesini yavaşlatır']
  },
  abutment: {
    name: 'Abutment (Bağlantı Parçası)', abbr: 'ABT', scope: 'tooth', phase: 3, price: 100, cur: 'EUR', group: 'implant',
    sessions: 'Kronla birlikte', duration: 'Kron yapımı süresince', color: '#9aa9b4', anim: 'generic',
    desc: 'İmplant ile üzerindeki kron arasında bağlantıyı sağlayan, implanta vidayla sabitlenen titanyum parça.',
    benefits: ['Kronun implanta sağlam ve doğru açıyla oturması', 'Diş eti ile uyumlu geçiş', 'Uzun dönem dayanıklılık']
  },
  abutmentCustom: {
    name: 'Kişiye Özel (Custom) Abutment', abbr: 'CAB', scope: 'tooth', phase: 3, price: 50, cur: 'EUR', group: 'implant',
    sessions: 'Kronla birlikte', duration: 'Kron yapımı süresince', color: '#a7b6c0', anim: 'generic',
    desc: 'Diş eti ve diş formuna göre dijital olarak tasarlanan, implant ile kron arasında bağlantıyı sağlayan kişiye özel bağlantı parçası.',
    benefits: ['Kronun implanta sağlam ve doğru açıyla oturması', 'Diş eti ile uyumlu geçiş', 'Uzun dönem dayanıklılık']
  },
  abutmentMedentika: {
    name: 'Medentika Abutment', abbr: 'MAB', scope: 'tooth', phase: 3, price: 125, cur: 'EUR', group: 'implant',
    sessions: 'Kronla birlikte', duration: 'Kron yapımı süresince', color: '#8c9ca7', anim: 'generic',
    desc: 'İmplant ile üzerindeki kron arasında bağlantıyı sağlayan, implanta vidayla sabitlenen titanyum parça.',
    benefits: ['Kronun implanta sağlam ve doğru açıyla oturması', 'Diş eti ile uyumlu geçiş', 'Uzun dönem dayanıklılık']
  },
  abutmentITI: {
    name: 'Straumann (ITI) Abutment', abbr: 'SAB', scope: 'tooth', phase: 3, price: 150, cur: 'EUR', group: 'implant',
    sessions: 'Kronla birlikte', duration: 'Kron yapımı süresince', color: '#7f909b', anim: 'generic',
    desc: 'İmplant ile üzerindeki kron arasında bağlantıyı sağlayan, implanta vidayla sabitlenen titanyum parça.',
    benefits: ['Kronun implanta sağlam ve doğru açıyla oturması', 'Diş eti ile uyumlu geçiş', 'Uzun dönem dayanıklılık']
  },
  implantustu: {
    name: 'İmplant Üstü Zirkonyum Kron', abbr: 'İÜK', scope: 'tooth', phase: 3, price: 16500, group: 'implant',
    sessions: '2–3 seans', duration: '1–2 hafta', color: '#78909c', anim: 'implant',
    desc: 'Kemikle kaynaşan implantın üzerine kişiye özel zirkonyum kron yerleştirilir. İmplant ile kron arasındaki bağlantı parçası (abutment) ayrı kalem olarak planlanır.',
    benefits: ['Doğal diş görünümü', 'Güçlü ve dayanıklı yapı', 'Kişiye özel renk ve form']
  },
  iuZirkonyum: {
    name: 'İmplant Üstü Zirkonyum Köprü', abbr: 'İZK', scope: 'multi', phase: 3, price: 16500, group: 'implant',
    sessions: '3–4 seans', duration: '2–3 hafta', color: '#2f9fd8', anim: 'fullArch',
    desc: 'İmplantlar kemikle bütünleştikten sonra, implantlara sabitlenen zirkonyum esaslı köprüler hazırlanır. Renk, form ve dizilim yüz yapısına göre kişiye özel tasarlanır. Fiyat üye (diş) sayısı üzerinden hesaplanır.',
    benefits: ['Doğal diş görünümüne yakın renk ve ışık geçirgenliği', 'İmplant destekli sabit kullanım konforu', 'Çiğneme ve konuşma fonksiyonlarının yeniden kazanılması']
  },
  iuMetalPorselen: {
    name: 'İmplant Üstü Metal Destekli Porselen', abbr: 'İMP-P', scope: 'multi', phase: 3, price: 10000, group: 'implant',
    sessions: '3–4 seans', duration: '2–3 hafta', color: '#c0844a', anim: 'fullArch',
    desc: 'Metal altyapının sağladığı mekanik destek ile porselenin estetik özelliklerini birleştiren, implantlara sabitlenen köprüler. Fiyat üye (diş) sayısı üzerinden hesaplanır.',
    benefits: ['Metal altyapının sağladığı mekanik destek', 'İmplant destekli sabit kullanım konforu', 'Zirkonyuma göre farklı bütçe seçeneği']
  },
  allon4: {
    name: 'All-on-4 Sabit Diş', abbr: 'A-4', scope: 'arch', phase: 2, price: 180000, group: 'implant', after: 'fixedArch',
    sessions: '2–4 seans', duration: 'Uygun vakada aynı gün geçici diş', color: '#455a64', anim: 'allon4',
    desc: 'Tüm çene, stratejik açılarla yerleştirilen 4 implant üzerine sabitlenen tek parça bir protezle yeniden yapılandırılır.',
    benefits: ['Takıp çıkarmaya gerek olmayan sabit dişler', 'Çoğu durumda ek kemik grefti gerekmez', 'Çiğneme ve konuşma konforu']
  },
  barGecici: {
    name: 'Titanyum Bar Destekli Sabit Geçici Protez', abbr: 'BGP', scope: 'arch', phase: 2, price: 1000, cur: 'EUR', group: 'implant',
    sessions: '1–2 seans', duration: 'İyileşme süresince', color: '#6d7f8c', anim: 'bar',
    desc: 'İyileşme döneminde implantlara titanyum bir bar ile bağlanan sabit geçici dişler uygulanır; günlük kullanımda çıkarılmaz.',
    benefits: ['İyileşme döneminde sabit diş konforu', 'İmplantlar arasında dengeli yük dağılımı', 'Estetik görünüm korunur']
  },
  geciciSabit: {
    name: 'Sabit Geçici Protez (PMMA)', abbr: 'GSP', scope: 'arch', phase: 2, price: 15000, group: 'implant',
    sessions: '1 seans', duration: 'Uygun vakada cerrahi sonrası', color: '#8e6bbf', anim: 'geciciSabit',
    desc: 'Primer stabilite ve yükleme koşulları uygunsa implantlar üzerine sabitlenen, PMMA (yüksek dayanımlı akrilik) malzemeden hazırlanan geçici dişler. Günlük kullanımda çıkarılmaz; uygulanabilirliği cerrahi sırasında belirlenir.',
    benefits: ['İyileşme döneminde sabit diş konforu', 'Çıkarıp takma gereği yok', 'Uygun vakalarda erken sabit rehabilitasyon']
  },
  barProtez: {
    name: 'Titanyum Bar Destekli Hibrit Zirkonyum Protez', abbr: 'BAR', scope: 'arch', phase: 3, price: 4500, cur: 'EUR', group: 'implant', after: 'fixedArch',
    sessions: '3–4 seans', duration: '2–3 hafta', color: '#546e7a', anim: 'bar',
    desc: 'İmplantların üzerine kişiye özel titanyum bir bar altyapı hazırlanır; zirkonyum dişlerle hazırlanan hibrit tam ark protez bu bara vidalanır. Hasta günlük kullanımda çıkarmaz; bakım için hekim tarafından sökülebilir.',
    benefits: ['Daha az sayıda implantla sabit tam ark diş', 'İmplantlar arasında rijit, güçlü bağlantı', 'Vidalı sistem: bakım ve onarım kolaylığı']
  },
  kron: {
    name: 'Zirkonyum Kron', abbr: 'KRN', scope: 'tooth', phase: 3, price: 16500, group: 'protez',
    sessions: '2–3 seans', duration: '5–7 gün', color: '#00a3d9', anim: 'kron',
    desc: 'Aşırı madde kaybı olan diş hassasça şekillendirilir, dijital ölçüyle kişiye özel üretilen zirkonyum kaplama ile korunur.',
    benefits: ['Diş kırılmaya karşı korunur', 'Doğal ışık geçirgenliği, metal içermez', 'Uzun ömürlü ve estetik']
  },
  tamSeramik: {
    name: 'Tam Seramik Kron (Metal Desteksiz)', abbr: 'TSK', scope: 'tooth', phase: 3, price: 20000, group: 'protez', base: 'kron',
    sessions: '2–3 seans', duration: '5–7 gün', color: '#29b6f6', anim: 'kron',
    desc: 'Metal altyapı içermeyen, ışık geçirgenliği yüksek seramikten kişiye özel üretilen kron; özellikle ön dişlerde en doğal görünümü sağlar.',
    benefits: ['Üst düzey estetik ve doğal ışık geçirgenliği', 'Metal içermez, diş eti kenarında gri renk oluşmaz', 'Biyouyumlu ve dayanıklı']
  },
  endokuron: {
    name: 'Endokron', abbr: 'ENK', scope: 'tooth', phase: 3, price: 15000, group: 'protez', base: 'kron',
    sessions: '2 seans', duration: '5–7 gün', color: '#26a1c9', anim: 'kron',
    desc: 'Kanal tedavili ve madde kaybı fazla olan dişte, kanal girişinden destek alan tek parça seramik restorasyon; ayrı bir post gerektirmeden dişi korur.',
    benefits: ['Diş dokusu maksimum korunur', 'Tek parça, dayanıklı yapı', 'Doğal görünüm']
  },
  onleySeramik: {
    name: 'Seramik Onley', abbr: 'ONL', scope: 'tooth', phase: 3, price: 15000, group: 'protez', base: 'dolgu',
    sessions: '2 seans', duration: '5–7 gün', color: '#4db6ac', anim: 'generic',
    desc: 'Büyük madde kaybı olan dişte, sağlam diş dokusu korunarak laboratuvarda kişiye özel üretilen seramik parça dişe yapıştırılır; kron yapılmadan dişin çiğneme tümsekleri yeniden oluşturulur.',
    benefits: ['Krona göre daha az diş kesimi', 'Diş renginde, lekelenmeye dirençli', 'Uzun ömürlü ve dayanıklı']
  },
  fiberPost: {
    name: 'Fiber Post', abbr: 'FP', scope: 'tooth', phase: 3, price: 4500, group: 'protez',
    sessions: '1 seans', duration: '20–30 dk', color: '#bcaaa4', anim: 'generic',
    desc: 'Kanal tedavisi görmüş ve madde kaybı fazla olan dişin kanalına cam fiber bir destek (post) yerleştirilir; üzerine yapılacak kron için sağlam bir temel oluşturulur.',
    benefits: ['Zayıf dişin kırılma riski azalır', 'Kron için sağlam temel', 'Diş renginde, metal içermeyen destek']
  },
  geciciKron: {
    name: 'Geçici Kron', abbr: 'GKR', scope: 'tooth', phase: 3, price: 2000, group: 'protez',
    sessions: '1 seans', duration: 'Kalıcı kron yapılana kadar', color: '#b0bec5', anim: 'kron',
    desc: 'Kalıcı kron hazırlanırken kesilen dişi korumak, estetik ve çiğneme fonksiyonunu sürdürmek için geçici kron uygulanır.',
    benefits: ['Hazırlanan diş korunur', 'Tedavi sürecinde estetik görünüm', 'Hassasiyet azalır']
  },
  kopru: {
    name: 'Zirkonyum Köprü', abbr: 'KPR', scope: 'multi', phase: 3, price: 16500, group: 'protez',
    sessions: '2–3 seans', duration: '5–7 gün', color: '#1e88e5', anim: 'kopru',
    desc: 'Eksik diş, komşu dişlerden destek alan tek parça bir köprü ile tamamlanır. Fiyat üye (diş) sayısı üzerinden hesaplanır.',
    benefits: ['Cerrahi işlem gerektirmez', 'Sabit ve hızlı çözüm', 'Çiğneme fonksiyonu geri kazanılır']
  },
  mpKopru: {
    name: 'Metal Destekli Porselen (Kron / Köprü)', abbr: 'MP', scope: 'multi', phase: 3, price: 10000, group: 'protez',
    sessions: '2–3 seans', duration: '5–7 gün', color: '#c0844a', anim: 'kopru',
    desc: 'Doğal dişler hazırlanır; metal altyapının üzerine diş renginde porselen kaplanarak kron veya köprü yapılır. Tek dişe kron, eksik dişe köprü olarak uygulanabilir. Fiyat üye (diş) sayısı üzerinden hesaplanır.',
    benefits: ['Güçlü metal altyapı ile dayanıklı yapı', 'Diş renginde porselen yüzey', 'Zirkonyuma göre daha ekonomik seçenek']
  },
  maryland: {
    name: 'Adeziv Köprü (Maryland)', abbr: 'ADK', scope: 'tooth', phase: 3, price: 15000, group: 'protez', after: 'pontic',
    sessions: '2 seans', duration: '5–7 gün', color: '#42a5f5', anim: 'kopru',
    desc: 'Eksik dişin yerine, komşu dişlerin arka yüzüne yapıştırılan kanatlarla tutunan bir köprü yapılır; komşu dişler kesilmez veya çok az hazırlanır. Eksik diş başına uygulanır.',
    benefits: ['Komşu dişlerde minimal kesim', 'Cerrahi gerektirmez', 'Hızlı ve estetik çözüm']
  },
  geciciHareketli: {
    name: 'Geçici (İmmediat) Hareketli Protez', abbr: 'GHP', scope: 'arch', phase: 2, price: 25000, group: 'protez',
    sessions: '1–2 seans', duration: 'İyileşme süresince', color: '#b388c9', anim: 'protez',
    desc: 'İmplantların iyileşme döneminde estetik görünümü korumak için hazırlanan, hasta tarafından takılıp çıkarılabilen geçici protez. İyileşen dokulara göre uyumlandırılabilir.',
    benefits: ['Estetik görünüm korunur', 'İyileşme sürecinde uyumlandırılabilir', 'Sabit geçici uygulanamadığında güvenli alternatif']
  },
  tamProtez: {
    name: 'Tam Protez (Akrilik)', abbr: 'PRT', scope: 'arch', phase: 3, price: 50000, group: 'protez', after: 'removableArch',
    sessions: '4–5 seans', duration: '2–3 hafta', color: '#ad7a99', anim: 'protez',
    desc: 'Dişsiz çene için kişiye özel ölçülerle hazırlanan, diş eti ve kemik üzerinde duran hareketli protez.',
    benefits: ['Hızlı ve ekonomik çözüm', 'Yüz desteği ve estetik geri kazanılır', 'Çiğneme ve konuşma iyileşir']
  },
  tamProtezMetal: {
    name: 'Metal Destekli Tam Protez', abbr: 'PRM', scope: 'arch', phase: 3, price: 58000, group: 'protez', after: 'removableArch',
    sessions: '4–5 seans', duration: '2–3 hafta', color: '#9c6b8f', anim: 'protez',
    desc: 'Dişsiz çene için, kırılmaya karşı döküm metal ile güçlendirilmiş kişiye özel hareketli protez.',
    benefits: ['Kırılmaya karşı daha dayanıklı', 'Yüz desteği ve estetik geri kazanılır', 'Çiğneme ve konuşma iyileşir']
  },
  bolumluProtez: {
    name: 'Bölümlü Protez (Akrilik)', abbr: 'BLP', scope: 'arch', phase: 3, price: 50000, group: 'protez', after: 'partial',
    sessions: '3–4 seans', duration: '2–3 hafta', color: '#c48bab', anim: 'protez',
    desc: 'Eksik dişler, kalan dişlerden destek alan ve hasta tarafından takılıp çıkarılan akrilik bir protezle tamamlanır.',
    benefits: ['Ekonomik ve hızlı çözüm', 'Çiğneme ve estetik iyileşir', 'Kalan dişlere yük dağıtır']
  },
  bolumluMetal: {
    name: 'Metal İskeletli Bölümlü Protez', abbr: 'BLM', scope: 'arch', phase: 3, price: 58000, group: 'protez', after: 'partial',
    sessions: '4–5 seans', duration: '2–3 hafta', color: '#a1887f', anim: 'protez',
    desc: 'Eksik dişler, ince ve dayanıklı bir metal iskelet üzerine hazırlanan, kalan dişlere tutunan hareketli bir protezle tamamlanır.',
    benefits: ['İnce ve hafif yapı, daha kolay alışma', 'Dayanıklı metal iskelet', 'Kalan dişlere dengeli tutunma']
  },
  hassasProtez: {
    name: 'Hassas Tutuculu Protez', abbr: 'HTP', scope: 'arch', phase: 3, price: 58000, group: 'protez', after: 'partial',
    sessions: '4–5 seans', duration: '3–4 hafta', color: '#b5784f', anim: 'hassasTutucu',
    desc: 'Eksik dişler, kalan dişlere yapılan kronlardaki hassas tutuculara (attachment) bağlanan bölümlü bir protezle tamamlanır. Kanca görünmez; protez tutuculara oturarak sağlam durur ve temizlik için çıkarılıp takılır. Hassas tutucular ve destek dişlerdeki kronlar ayrıca ücretlendirilir.',
    benefits: ['Görünen metal kanca yok, estetik sonuç', 'Klasik bölümlü protezden daha sağlam ve dengeli tutuculuk', 'Kalan doğal dişlerden destek alır', 'Temizlik için kolayca çıkarılıp takılır']
  },
  hassasTutucu: {
    name: 'Hassas Tutucu (Attachment)', abbr: 'HT', scope: 'tooth', phase: 3, price: 100, cur: 'EUR', group: 'protez',
    sessions: 'Kronla birlikte', duration: 'Kron yapımı süresince', color: '#c9a227', anim: 'hassasTutucu',
    desc: 'Destek dişe yapılan kronun içine yerleştirilen, hareketli protezi kanca olmadan tutan hassas bağlantı parçası. Fiyat tutucu sayısı üzerinden hesaplanır: tutucunun takılacağı destek dişleri seçin.',
    benefits: ['Görünen metal kanca olmadan tutuculuk', 'Protezin sağlam ve dengeli oturması', 'Destek dişe binen yükün dengelenmesi']
  },
  overdenture: {
    name: 'İmplant Üstü Hareketli Protez (Overdenture)', abbr: 'OVD', scope: 'arch', phase: 3, price: 58000, group: 'protez', after: 'removableArch',
    sessions: '4–5 seans', duration: '2–3 hafta', color: '#a0638a', anim: 'overdenture',
    desc: 'Çeneye yerleştirilen 2–4 implantın üzerine tutucu başlıklar (locator) takılır. Kişiye özel hazırlanan protez bu başlıklara “klik” diye oturur; yerinde sağlam durur, temizlik için hasta tarafından çıkarılıp takılır. İmplantlar ve tutucu başlıklar (hassas tutucu) ayrıca ücretlendirilir.',
    benefits: ['Klasik protezden çok daha sağlam tutuculuk, yapıştırıcıya gerek kalmaz', 'Daha az sayıda implantla ekonomik çözüm', 'Temizlik için kolayca çıkarılıp takılır', 'Çiğneme ve konuşma güveni artar']
  },
  disUstuOverdenture: {
    name: 'Diş Üstü Hareketli Protez (Overdenture)', abbr: 'DÜP', scope: 'arch', phase: 3, price: 23500, group: 'protez', after: 'removableArch',
    sessions: '4–5 seans', duration: '2–3 hafta', color: '#b07aa1', anim: 'protez',
    desc: 'Kanal tedavisi yapılıp kısaltılan doğal diş kökleri korunur; hareketli protez bu köklerin üzerine oturur. Kökler, protezin tutuculuğunu ve kemiğin korunmasını destekler.',
    benefits: ['Doğal kökler sayesinde kemik korunur', 'Klasik protezden daha iyi tutuculuk', 'Ekonomik çözüm']
  },
  lamina: {
    name: 'Porselen Lamina', abbr: 'LMN', scope: 'tooth', phase: 3, price: 20000, group: 'estetik',
    sessions: '2–3 seans', duration: '7–10 gün', color: '#b46ef0', anim: 'lamina',
    desc: 'Diş yüzeyinden çok ince bir katman hazırlanır, kişiye özel tasarlanan porselen yapraklar dişlerin ön yüzüne yapıştırılır.',
    benefits: ['Minimal diş kesimi', 'Renk, form ve boşluk sorunları tek seferde düzelir', 'Lekelenmeye dirençli, parlak yüzey']
  },
  kompozitLamina: {
    name: 'Kompozit Lamina (Direkt)', abbr: 'KLM', scope: 'tooth', phase: 3, price: 10000, group: 'estetik', base: 'lamina',
    sessions: '1 seans', duration: '45–60 dk / diş', color: '#c792ea', anim: 'lamina',
    desc: 'Dişin ön yüzü, diş renginde kompozit malzemeyle doğrudan ağız içinde şekillendirilerek renk, form ve boşluk sorunları giderilir.',
    benefits: ['Tek seansta sonuç', 'Minimal veya hiç diş kesimi', 'Gerektiğinde kolayca onarılabilir']
  },
  bonding: {
    name: 'Bonding', abbr: 'BND', scope: 'tooth', phase: 3, price: 9000, group: 'estetik',
    sessions: '1 seans', duration: '30–45 dk / diş', color: '#9575cd', anim: 'lamina',
    desc: 'Kırık, aralık veya şekil bozukluğu olan dişlere, diş renginde kompozit malzeme yapıştırılıp şekillendirilerek estetik düzeltme yapılır.',
    benefits: ['Diş kesimi gerektirmez', 'Tek seansta estetik düzeltme', 'Doğal görünüm']
  },
  beyazlatma: {
    name: 'Diş Beyazlatma', abbr: 'BYZ', scope: 'arch', phase: 3, price: 15000, group: 'estetik',
    sessions: '1 seans', duration: '60–90 dk', color: '#f2b705', anim: 'beyazlatma',
    desc: 'Diş etleri korunarak dişlere beyazlatıcı jel uygulanır ve özel ışıkla aktive edilir. Dişlerin rengi birkaç ton açılır. Fiyat çene başına hesaplanır.',
    benefits: ['Tek seansta belirgin sonuç', 'Diş yapısına zarar vermez', 'Daha parlak ve genç bir gülüş']
  },
  ortodonti: {
    name: 'Şeffaf Plak Tedavisi', abbr: 'ORT', scope: 'mouth', phase: 2, price: 90000, group: 'estetik',
    sessions: 'Kontrol: 6–8 haftada bir', duration: '6–18 ay', color: '#26a69a', anim: 'ortodonti',
    desc: 'Kişiye özel üretilen şeffaf plaklar sırayla kullanılarak dişler planlanan konumlarına adım adım taşınır.',
    benefits: ['Neredeyse görünmez', 'Yemek ve temizlik için çıkarılabilir', 'Dijital planlama ile sonucu baştan görme']
  },
  gecePlagi: {
    name: 'Gece Plağı', abbr: 'GPL', scope: 'mouth', phase: 4, price: 5000, group: 'estetik',
    sessions: '2 seans', duration: '3–5 gün', color: '#7e57c2', anim: 'gecePlagi',
    desc: 'Gece diş sıkma ve gıcırdatmaya karşı kişiye özel hazırlanan şeffaf koruyucu plak.',
    benefits: ['Diş ve kaplamaları aşınmaya karşı korur', 'Çene eklemi ve kas ağrılarını azaltır', 'Yapılan tedavinin ömrünü uzatır']
  }
};

const TX_ORDER = ['detartraj', 'airflow', 'kuretaj', 'dolgu', 'kanal', 'kanal2', 'kanal3', 'kronSokumu', 'cekim',
  'cekimKomplike', 'gomulu', 'gomuluKemik', 'greft', 'membran', 'sinus', 'kronBoyUzatma', 'implantCikarma',
  'implantRehberi', 'implantRehberiYarim', 'implant', 'implantStraumann', 'implantBLX', 'implantMedentika',
  'implantEvos', 'abutment', 'abutmentCustom', 'abutmentMedentika', 'abutmentITI', 'implantustu', 'iuZirkonyum',
  'iuMetalPorselen', 'allon4', 'barGecici', 'geciciSabit', 'barProtez', 'kron', 'tamSeramik', 'endokuron',
  'onleySeramik', 'fiberPost', 'geciciKron', 'kopru', 'mpKopru', 'maryland', 'geciciHareketli', 'tamProtez',
  'tamProtezMetal', 'bolumluProtez', 'bolumluMetal', 'hassasProtez', 'hassasTutucu', 'overdenture',
  'disUstuOverdenture', 'lamina', 'kompozitLamina', 'bonding', 'beyazlatma', 'ortodonti', 'gecePlagi'];
const MULTI_CROWN = { kopru: 'zirconia', mpKopru: 'pfm', iuZirkonyum: 'zirconia', iuMetalPorselen: 'pfm' };
const txBase = k => (TX[k] && TX[k].base) || k;
const PAL_GROUPS = [['temel', 'Temel tedaviler'], ['cerrahi', 'Cerrahi'], ['implant', 'İmplant'], ['protez', 'Protez'], ['estetik', 'Estetik & diğer']];
const SCOPE_TAG = { multi: 'üye', quad: 'yarım çene', arch: 'çene', mouth: 'tüm ağız' };

const FINDINGS = {
  curuk: { name: 'Çürük', abbr: 'Ç', color: '#6d4c41' },
  kirik: { name: 'Kırık / Aşınmış', abbr: 'K', color: '#ef6c00' },
  iltihap: { name: 'Apse / İltihap', abbr: 'A', color: '#e53935' },
  eksik: { name: 'Eksik Diş', abbr: 'E', color: '#90a4ae' },
  sallanan: { name: 'Sallanan Diş', abbr: 'S', color: '#f9a825' },
  gomulu: { name: 'Gömülü Diş', abbr: 'G', color: '#8e24aa' },
  kanalli: { name: 'Kanal Tedavili', abbr: 'KT', color: '#f08a3c' },
  dolgu: { name: 'Mevcut Dolgu', abbr: 'D', color: '#78909c' },
  kron: { name: 'Mevcut Kron', abbr: 'KR', color: '#90a4ae' },
  implant: { name: 'Mevcut İmplant', abbr: 'İ', color: '#607d8b' }
};
const FINDING_ORDER = ['curuk', 'kirik', 'iltihap', 'eksik', 'sallanan', 'gomulu', 'kanalli', 'dolgu', 'kron', 'implant'];

/* FDI diş numaraları — hastanın sağı ekranın solunda */
const UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
const LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];
const ALL_TEETH = [...UPPER, ...LOWER];
const TOOTH_W = { 1: 30, 2: 27, 3: 29, 4: 30, 5: 29, 6: 40, 7: 38, 8: 35 };

const isUpper = n => { const q = Math.floor(n / 10); return q === 1 || q === 2; };
const archTeeth = arch => arch === 'upper' ? UPPER : LOWER;
const toothName = n => {
  const p = n % 10;
  const t = p <= 2 ? 'Kesici' : p === 3 ? 'Köpek' : p <= 5 ? 'Küçük azı' : p === 8 ? 'Yirmilik' : 'Büyük azı';
  return `${n} · ${isUpper(n) ? 'Üst' : 'Alt'} ${t}`;
};

/* Yarım çene (bölge): FDI 1 sağ üst, 2 sol üst, 3 sol alt, 4 sağ alt */
const QUAD_NAMES = { 1: 'Sağ üst bölge', 2: 'Sol üst bölge', 3: 'Sol alt bölge', 4: 'Sağ alt bölge' };
const quadOf = n => Math.floor(n / 10);
const quadTeeth = qd => ALL_TEETH.filter(n => quadOf(n) === qd);
