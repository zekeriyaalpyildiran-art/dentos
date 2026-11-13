/* =========================================================
   Katalog: tedaviler, bulgular, fazlar, diş düzeni
   ========================================================= */

const PHASES = {
  1: { name: 'Temel Tedaviler', desc: 'Ağrı, enfeksiyon ve çürüklerin giderilmesi', color: '#3aa6b9' },
  2: { name: 'Cerrahi Aşama', desc: 'Çekim, implant ve kemik işlemleri', color: '#e0864a' },
  3: { name: 'Protetik & Estetik', desc: 'Kalıcı dişler, kaplamalar ve gülüş tasarımı', color: '#7b6cf6' },
  4: { name: 'Koruma & Bakım', desc: 'Sonucun uzun ömürlü olması için', color: '#43a26b' }
};

/* scope: tooth = dişe tıklanır, multi = birden fazla diş (köprü),
          arch = çene (üst/alt), mouth = tüm ağız */
const TX = {
  detartraj: {
    name: 'Diş Taşı Temizliği', abbr: 'TMZ', scope: 'mouth', phase: 1, price: 2500,
    sessions: '1 seans', duration: '30–45 dk', color: '#3fb3c4', anim: 'detartraj',
    desc: 'Diş yüzeylerinde ve diş eti çizgisinde biriken diş taşı (tartar), ultrasonik uçlarla nazikçe temizlenir ve yüzeyler cilalanır.',
    benefits: ['Diş eti kanaması ve iltihabı azalır', 'Ağız kokusunun önüne geçilir', 'Diğer tedaviler sağlıklı bir zeminde başlar']
  },
  kuretaj: {
    name: 'Diş Eti Tedavisi (Küretaj)', abbr: 'KÜR', scope: 'mouth', phase: 1, price: 6000,
    sessions: '1–2 seans', duration: 'Seans başı 45–60 dk', color: '#e0607e', anim: 'kuretaj',
    desc: 'Diş eti cebinin derinlerinde, kök yüzeyine yapışmış birikintiler ve iltihaplı doku temizlenir. Diş eti yeniden dişe sıkıca tutunur.',
    benefits: ['Diş kaybının en önemli nedeni olan diş eti hastalığı durdurulur', 'Sallanma riski azalır', 'Diş eti sağlıklı pembe rengine kavuşur']
  },
  dolgu: {
    name: 'Kompozit Dolgu', abbr: 'DLG', scope: 'tooth', phase: 1, price: 3000,
    sessions: '1 seans', duration: '30–45 dk / diş', color: '#4f8ef7', anim: 'dolgu',
    desc: 'Çürük doku temizlenir, diş kendi renginde kompozit malzemeyle katman katman doldurulur ve özel ışıkla sertleştirilir.',
    benefits: ['Diş renginde, fark edilmeyen sonuç', 'Çürüğün ilerlemesi durdurulur', 'Diş dokusu maksimum korunur']
  },
  kanal: {
    name: 'Kanal Tedavisi', abbr: 'KNL', scope: 'tooth', phase: 1, price: 6500,
    sessions: '1–2 seans', duration: '60–90 dk / seans', color: '#e94f4f', anim: 'kanal',
    desc: 'İltihaplanmış sinir dokusu temizlenir, kanallar dezenfekte edilip kalıcı olarak doldurulur. Diş çekilmeden ağızda kalır.',
    benefits: ['Ağrı ve enfeksiyon ortadan kalkar', 'Doğal diş korunur, çekime gerek kalmaz', 'Modern yöntemlerle konforlu işlem']
  },
  cekim: {
    name: 'Diş Çekimi', abbr: 'ÇKM', scope: 'tooth', phase: 2, price: 2500,
    sessions: '1 seans', duration: '20–40 dk', color: '#8d6e63', anim: 'cekim',
    desc: 'Kurtarılması mümkün olmayan diş, lokal anestezi altında çevre dokular korunarak nazikçe çıkarılır.',
    benefits: ['Enfeksiyon kaynağı ortadan kalkar', 'Komşu dişler ve kemik korunur', 'Yeni diş için sağlıklı zemin hazırlanır']
  },
  greft: {
    name: 'Kemik Grefti', abbr: 'GRF', scope: 'tooth', phase: 2, price: 8000,
    sessions: '1 seans', duration: '4–6 ay iyileşme', color: '#c9a227', anim: 'greft',
    desc: 'Kemik kaybı olan bölgeye kemik tozu yerleştirilir ve koruyucu bir zarla örtülür. Zamanla yeni kemik oluşur.',
    benefits: ['İmplant için yeterli kemik hacmi sağlanır', 'Yüz ve diş eti desteği korunur', 'Uzun vadeli estetik sonuç']
  },
  sinus: {
    name: 'Sinüs Lifting', abbr: 'SNS', scope: 'tooth', phase: 2, price: 15000,
    sessions: '1 seans', duration: '4–6 ay iyileşme', color: '#5e9fd6', anim: 'sinus',
    desc: 'Üst arka bölgede sinüs boşluğu nedeniyle kemik yetersizse, sinüs zarı nazikçe kaldırılır ve altına kemik grefti yerleştirilir.',
    benefits: ['Üst çene arka bölgeye implant yapılabilir hale gelir', 'İmplant uzun ve güçlü kemikte durur', 'Kalıcı ve güvenilir çözüm']
  },
  implant: {
    name: 'İmplant', abbr: 'İMP', scope: 'tooth', phase: 2, price: 25000,
    sessions: '1 seans + iyileşme', duration: '2–4 ay kaynaşma', color: '#607d8b', anim: 'implant',
    desc: 'Eksik dişin yerine çene kemiğine titanyum bir yapay kök yerleştirilir. Kemikle kaynaştıktan sonra üzerine kalıcı diş yapılır.',
    benefits: ['Komşu dişlere dokunulmaz', 'Doğal diş gibi çiğneme hissi', 'Kemik erimesini yavaşlatır']
  },
  implantustu: {
    name: 'İmplant Üstü Zirkonyum', abbr: 'İÜK', scope: 'tooth', phase: 3, price: 12000,
    sessions: '2–3 seans', duration: '1–2 hafta', color: '#78909c', anim: 'implant',
    desc: 'Kemikle kaynaşan implantın üzerine bağlantı parçası (abutment) ve kişiye özel zirkonyum diş yerleştirilir.',
    benefits: ['Doğal diş görünümü', 'Güçlü ve dayanıklı yapı', 'Kişiye özel renk ve form']
  },
  allon4: {
    name: 'All-on-4 Sabit Diş', abbr: 'A-4', scope: 'arch', phase: 2, price: 180000,
    sessions: '2–4 seans', duration: 'Uygun vakada aynı gün geçici diş', color: '#455a64', anim: 'allon4',
    desc: 'Tüm çene, stratejik açılarla yerleştirilen 4 implant üzerine sabitlenen tek parça bir protezle yeniden yapılandırılır.',
    benefits: ['Takıp çıkarmaya gerek olmayan sabit dişler', 'Çoğu durumda ek kemik grefti gerekmez', 'Çiğneme ve konuşma konforu']
  },
  tamProtez: {
    name: 'Tam Protez', abbr: 'PRT', scope: 'arch', phase: 3, price: 30000,
    sessions: '4–5 seans', duration: '2–3 hafta', color: '#ad7a99', anim: 'protez',
    desc: 'Dişsiz çene için kişiye özel ölçülerle hazırlanan, diş eti ve kemik üzerinde duran hareketli protez.',
    benefits: ['Hızlı ve ekonomik çözüm', 'Yüz desteği ve estetik geri kazanılır', 'Çiğneme ve konuşma iyileşir']
  },
  kron: {
    name: 'Zirkonyum Kron', abbr: 'KRN', scope: 'tooth', phase: 3, price: 9000,
    sessions: '2–3 seans', duration: '5–7 gün', color: '#00a3d9', anim: 'kron',
    desc: 'Aşırı madde kaybı olan diş hassasça şekillendirilir, dijital ölçüyle kişiye özel üretilen zirkonyum kaplama ile korunur.',
    benefits: ['Diş kırılmaya karşı korunur', 'Doğal ışık geçirgenliği, metal içermez', 'Uzun ömürlü ve estetik']
  },
  lamina: {
    name: 'Porselen Lamina', abbr: 'LMN', scope: 'tooth', phase: 3, price: 12000,
    sessions: '2–3 seans', duration: '7–10 gün', color: '#b46ef0', anim: 'lamina',
    desc: 'Diş yüzeyinden çok ince bir katman hazırlanır, kişiye özel tasarlanan porselen yapraklar dişlerin ön yüzüne yapıştırılır.',
    benefits: ['Minimal diş kesimi', 'Renk, form ve boşluk sorunları tek seferde düzelir', 'Lekelenmeye dirençli, parlak yüzey']
  },
  kopru: {
    name: 'Zirkonyum Köprü', abbr: 'KPR', scope: 'multi', phase: 3, price: 9000,
    sessions: '2–3 seans', duration: '5–7 gün', color: '#1e88e5', anim: 'kopru',
    desc: 'Eksik diş, komşu dişlerden destek alan tek parça bir köprü ile tamamlanır. Fiyat üye (diş) sayısı üzerinden hesaplanır.',
    benefits: ['Cerrahi işlem gerektirmez', 'Sabit ve hızlı çözüm', 'Çiğneme fonksiyonu geri kazanılır']
  },
  beyazlatma: {
    name: 'Diş Beyazlatma', abbr: 'BYZ', scope: 'mouth', phase: 3, price: 8000,
    sessions: '1 seans', duration: '60–90 dk', color: '#f2b705', anim: 'beyazlatma',
    desc: 'Diş etleri korunarak dişlere beyazlatıcı jel uygulanır ve özel ışıkla aktive edilir. Dişlerin rengi birkaç ton açılır.',
    benefits: ['Tek seansta belirgin sonuç', 'Diş yapısına zarar vermez', 'Daha parlak ve genç bir gülüş']
  },
  iuZirkonyum: {
    name: 'İmplant Üstü Zirkonyum Köprü', abbr: 'İZK', scope: 'multi', phase: 3, price: 16500,
    sessions: '3–4 seans', duration: '2–3 hafta', color: '#2f9fd8', anim: 'fullArch',
    desc: 'İmplantlar kemikle bütünleştikten sonra, implantlara sabitlenen zirkonyum esaslı köprüler hazırlanır. Renk, form ve dizilim yüz yapısına göre kişiye özel tasarlanır. Fiyat üye (diş) sayısı üzerinden hesaplanır.',
    benefits: ['Doğal diş görünümüne yakın renk ve ışık geçirgenliği', 'İmplant destekli sabit kullanım konforu', 'Çiğneme ve konuşma fonksiyonlarının yeniden kazanılması']
  },
  iuMetalPorselen: {
    name: 'İmplant Üstü Metal Destekli Porselen', abbr: 'İMP-P', scope: 'multi', phase: 3, price: 10000,
    sessions: '3–4 seans', duration: '2–3 hafta', color: '#c0844a', anim: 'fullArch',
    desc: 'Metal altyapının sağladığı mekanik destek ile porselenin estetik özelliklerini birleştiren, implantlara sabitlenen köprüler. Fiyat üye (diş) sayısı üzerinden hesaplanır.',
    benefits: ['Metal altyapının sağladığı mekanik destek', 'İmplant destekli sabit kullanım konforu', 'Zirkonyuma göre farklı bütçe seçeneği']
  },
  overdenture: {
    name: 'İmplant Üstü Hareketli Protez (Overdenture)', abbr: 'OVD', scope: 'arch', phase: 3, price: 35000,
    sessions: '4–5 seans', duration: '2–3 hafta', color: '#a0638a', anim: 'overdenture',
    desc: 'Çeneye yerleştirilen 2–4 implantın üzerine tutucu başlıklar (locator) takılır. Kişiye özel hazırlanan protez bu başlıklara “klik” diye oturur; yerinde sağlam durur, temizlik için hasta tarafından çıkarılıp takılır. İmplantlar ayrıca ücretlendirilir.',
    benefits: ['Klasik protezden çok daha sağlam tutuculuk, yapıştırıcıya gerek kalmaz', 'Daha az sayıda implantla ekonomik çözüm', 'Temizlik için kolayca çıkarılıp takılır', 'Çiğneme ve konuşma güveni artar']
  },
  hassasTutucu: {
    name: 'Hassas Tutuculu Protez', abbr: 'HTP', scope: 'arch', phase: 3, price: 30000,
    sessions: '4–5 seans', duration: '3–4 hafta', color: '#b5784f', anim: 'hassasTutucu',
    desc: 'Eksik dişler, kalan dişlere yapılan kronlardaki hassas tutucularla (attachment) bağlanan bölümlü bir protezle tamamlanır. Kanca görünmez; protez tutuculara oturarak sağlam durur ve temizlik için çıkarılıp takılır. Destek dişlerdeki kronlar ayrıca ücretlendirilir.',
    benefits: ['Görünen metal kanca yok, estetik sonuç', 'Klasik bölümlü protezden daha sağlam ve dengeli tutuculuk', 'Kalan doğal dişlerden destek alır', 'Temizlik için kolayca çıkarılıp takılır']
  },
  barProtez: {
    name: 'Titanyum Bar Destekli Sabit Protez', abbr: 'BAR', scope: 'arch', phase: 3, price: 4500,
    sessions: '3–4 seans', duration: '2–3 hafta', color: '#546e7a', anim: 'bar',
    desc: 'İmplantların üzerine kişiye özel titanyum bir bar altyapı hazırlanır ve tam ark protez bu bara vidalanır. Hasta günlük kullanımda çıkarmaz; bakım için hekim tarafından sökülebilir.',
    benefits: ['Daha az sayıda implantla sabit tam ark diş', 'İmplantlar arasında rijit, güçlü bağlantı', 'Vidalı sistem: bakım ve onarım kolaylığı']
  },
  geciciHareketli: {
    name: 'Hareketli Geçici Protez', abbr: 'GHP', scope: 'arch', phase: 2, price: 0,
    sessions: '1–2 seans', duration: 'İyileşme süresince', color: '#b388c9', anim: 'protez',
    desc: 'İmplantların iyileşme döneminde estetik görünümü korumak için hazırlanan, hasta tarafından takılıp çıkarılabilen geçici protez. İyileşen dokulara göre uyumlandırılabilir.',
    benefits: ['Estetik görünüm korunur', 'İyileşme sürecinde uyumlandırılabilir', 'Sabit geçici uygulanamadığında güvenli alternatif']
  },
  geciciSabit: {
    name: 'Sabit Geçici Protez (PMMA)', abbr: 'GSP', scope: 'arch', phase: 2, price: 15000,
    sessions: '1 seans', duration: 'Uygun vakada cerrahi sonrası', color: '#8e6bbf', anim: 'geciciSabit',
    desc: 'Primer stabilite ve yükleme koşulları uygunsa implantlar üzerine sabitlenen, PMMA (yüksek dayanımlı akrilik) malzemeden hazırlanan geçici dişler. Günlük kullanımda çıkarılmaz; uygulanabilirliği cerrahi sırasında belirlenir.',
    benefits: ['İyileşme döneminde sabit diş konforu', 'Çıkarıp takma gereği yok', 'Uygun vakalarda erken sabit rehabilitasyon']
  },
  ortodonti: {
    name: 'Şeffaf Plak Tedavisi', abbr: 'ORT', scope: 'mouth', phase: 2, price: 90000,
    sessions: 'Kontrol: 6–8 haftada bir', duration: '6–18 ay', color: '#26a69a', anim: 'ortodonti',
    desc: 'Kişiye özel üretilen şeffaf plaklar sırayla kullanılarak dişler planlanan konumlarına adım adım taşınır.',
    benefits: ['Neredeyse görünmez', 'Yemek ve temizlik için çıkarılabilir', 'Dijital planlama ile sonucu baştan görme']
  },
  gecePlagi: {
    name: 'Gece Plağı', abbr: 'GPL', scope: 'mouth', phase: 4, price: 4500,
    sessions: '2 seans', duration: '3–5 gün', color: '#7e57c2', anim: 'gecePlagi',
    desc: 'Gece diş sıkma ve gıcırdatmaya karşı kişiye özel hazırlanan şeffaf koruyucu plak.',
    benefits: ['Diş ve kaplamaları aşınmaya karşı korur', 'Çene eklemi ve kas ağrılarını azaltır', 'Yapılan tedavinin ömrünü uzatır']
  }
};

const TX_ORDER = ['detartraj', 'kuretaj', 'dolgu', 'kanal', 'cekim', 'greft', 'sinus', 'implant', 'implantustu',
  'allon4', 'geciciHareketli', 'geciciSabit', 'tamProtez', 'overdenture', 'hassasTutucu', 'barProtez', 'ortodonti', 'kron', 'lamina', 'kopru',
  'iuZirkonyum', 'iuMetalPorselen', 'beyazlatma', 'gecePlagi'];
const MULTI_CROWN = { kopru: 'zirconia', iuZirkonyum: 'zirconia', iuMetalPorselen: 'pfm' };

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
