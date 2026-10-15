# Edge Functions

## 1. invite-staff: ne yapar

`invite-staff`, Ekip ekranındaki personele e-posta daveti gönderir (`invite`) ve şifresini henüz belirlememiş personele şifre belirleme bağlantısını yeniden gönderir (`resend`). Yalnız **aktif klinik sahibi veya yönetici** çağırabilir. Bütün yetki ve hedef kontrolleri veritabanında (migration 0027'deki `plt_svc_*` fonksiyonları) yapılır. Kaynak kodun asıl yeri repodaki `supabase/functions/invite-staff/index.ts` dosyasıdır. Dashboard'daki kod her zaman bu dosyanın kopyası olmalıdır.

- Web uygulaması fonksiyonu `supabase.functions.invoke("invite-staff", { body: { action, user_id } })` ile çağırır (`apps/web/src/lib/staff.ts`).
- Davet e-postası ve yeniden gönderilen e-posta aynı adrese yönlenir: `SITE_URL + "/reset-password"`. Bu sayfa davet bağlantısında "Şifrenizi belirleyin" başlığını gösterir.
- Fonksiyon hiçbir yanıtta anahtar, token veya bağlantı döndürmez.

## 2. Önkoşul

Önce `packages/db/migrations/0027_platform_staff_audit.sql` Supabase SQL Editor'da çalıştırılmış olmalı. Çalıştırılmadıysa fonksiyon her istekte `FN_CONFIG` ("Davet servisi yapılandırması eksik…") döner.

Sıra: migration → fonksiyon + Auth ayarları (bu belge) → web deploy.

## 3. Dashboard ile kurulum (Deploy via Editor)

1. supabase.com → proje `knzrcgqpzjbajfboqlhq` → sol menü **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Function name **tam olarak** `invite-staff` olmalı (web uygulaması bu adı çağırır).
3. Örnek kodu silin, `supabase/functions/invite-staff/index.ts` dosyasının **tamamını** yapıştırın → **Deploy function**.
4. Fonksiyonun **Details / Settings** sayfasında "Enforce JWT verification" **açık** kalabilir; fonksiyon token'ı ayrıca kendisi de doğrular. Geçerli kullanıcılar gateway'den `401 Invalid JWT` alıyorsa (yeni JWT signing keys kullanan projelerde olabilir) bu ayarı **kapatın**. Fonksiyonun kendi kontrolü (`auth.getUser`) yine geçerlidir.
5. **Edge Functions → Secrets**: `SITE_URL = https://dentos.klinikprimemaltepe.com` (kliniğin alan adı; sonunda `/` olmadan). Boş bırakılırsa varsayılan `https://dentos-eight.vercel.app` olur. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` **eklemeyin**: Supabase bunları otomatik sağlar. `ALLOW_LOCAL_ORIGIN` secret'ını üretimde **eklemeyin** (aşağıya bakın).
6. Fonksiyon adresi: `https://knzrcgqpzjbajfboqlhq.supabase.co/functions/v1/invite-staff`.

İzin verilen tarayıcı kaynakları (CORS): `https://dentos-eight.vercel.app` ve `SITE_URL`'in kendisi. `http://localhost:3002` yalnız `ALLOW_LOCAL_ORIGIN = 1` secret'ı varken izinlidir; bunu yalnız bilgisayarınızda yerel test yaparken geçici olarak ekleyin, test bitince silin. Vercel önizleme (preview) adresleri bilinçli olarak izinli değildir. CORS izni tek başına yetki vermez: her istek, oturum açmış aktif sahip/yöneticinin token'ını taşımak zorundadır ve bu token yalnız uygulamanın kendi adresinde saklanır.

## 4. Auth ayarları (Authentication)

1. **URL Configuration**: Site URL `https://dentos.klinikprimemaltepe.com` (kliniğin alan adı; Vercel'de bağlı). Redirect URLs listesinde yalnız uygulamanın gerçekten kullanılan üretim adreslerinin `/reset-password` yolu kalmalı:
   - `https://dentos.klinikprimemaltepe.com/reset-password`
   - `https://dentos-eight.vercel.app/reset-password` (Vercel'in kendi adresi; hâlâ açılıyor)

   Giriş sayfasındaki "Şifremi unuttum" bağlantıyı uygulamanın açıldığı adrese yönlendirir; o adres listede yoksa bağlantı ana sayfaya düşer ve çalışmaz. Yeni bir alan adı bağlanırsa onun `/reset-password` yolu da eklenmelidir.

   Listede `*` içeren joker adresler (ör. `https://*.vercel.app/**`) varsa **silin**: davet ve şifre bağlantılarındaki oturum bilgisi bu adreslere gönderilebilir. `http://localhost:3002/reset-password` yalnız bilgisayarınızda yerel test yaparken geçici olarak eklenip test bitince silinmelidir. Davetler özel alan adından gönderilecekse aynı adresi `SITE_URL` olarak da girin (CORS izni de buradan gelir).
2. **SMTP** (zaten kurulu: Hostinger, gönderen `info@klinikprimemaltepe.com`): olduğu gibi bırakın; yalnız gönderen adının (Sender name) doğru olduğunu kontrol edin.
3. **Emails → Templates**: aşağıdaki iki şablonu birebir kopyalayın.

   **Invite user**. Subject: `DentOS daveti: şifrenizi belirleyin`

   ```html
   <h2>DentOS'a davet edildiniz</h2>
   <p>Merhaba{{ if .Data.full_name }} {{ .Data.full_name }}{{ end }},</p>
   <p>{{ if .Data.clinic_name }}{{ .Data.clinic_name }}{{ else }}Kliniğiniz{{ end }} sizi DentOS klinik yönetim paneline ekledi.
   Hesabınızı etkinleştirmek için aşağıdaki bağlantıya tıklayın ve şifrenizi belirleyin.</p>
   <p><a href="{{ .ConfirmationURL }}">Şifremi belirle</a></p>
   <p>Bağlantı 24 saat geçerlidir ve yalnızca bir kez kullanılabilir. Bu daveti beklemiyorsanız bu e-postayı yok sayabilirsiniz.</p>
   ```

   **Reset password**. Subject: `DentOS: şifre belirleme bağlantınız`

   ```html
   <h2>Şifrenizi belirleyin</h2>
   <p>DentOS hesabınız için şifre belirleme / yenileme bağlantısı istendi.</p>
   <p><a href="{{ .ConfirmationURL }}">Şifremi belirle</a></p>
   <p>Bağlantı 24 saat geçerlidir ve yalnızca bir kez kullanılabilir. Bu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz; şifreniz değişmez.</p>
   ```

   ("Şifremi unuttum" da aynı Reset password şablonunu kullanır; metin iki durum için de uygundur.)
4. **Sign In / Providers → Email**: **Email OTP Expiration** = `86400` (24 saat; davet ve şifre bağlantıları). "Confirm email" açık kalsın. Varsayılan 1 saat bırakılırsa iki şablondaki "24 saat" ifadesini "1 saat" yapın.
5. **Rate Limits**: "Rate limit for sending emails" saatte en az 30 olursa davetler için yeterlidir.
6. **Zorunlu: Allow new users to sign up = OFF** (Sign In / Providers → "Allow new users to sign up" kapalı). Uygulama kendi kendine kayıt kullanmaz; davetler ve "Şifremi unuttum" bu ayar kapalıyken de çalışır. Açık kalırsa, personelin e-posta adresini bilen biri davet gönderilmeden hemen önce o adresle kendi şifresiyle kayıt olabilir; Supabase onaylanmamış hesaba daveti yeniden gönderir. Veritabanı (0027) şifresi olan bir hesabı personele bağlamayı reddeder, yine de kapalı tutulması gerekir.
7. **Zorunlu: Secure password change = ON** (Sign In / Providers → Email). Davet ve şifre bağlantısıyla açılan oturumlar etkilenmez; 24 saatten eski bir oturumda şifre değiştirmek için yeniden doğrulama ister. `/reset-password` sayfası zaten yalnız e-postadaki bağlantıyla açılır; bu ayar, açık bırakılmış bir tarayıcıda API üzerinden şifre değiştirilmesini de zorlaştırır.
8. **Attack Protection → CAPTCHA kapalı kalmalı.** Giriş sayfasındaki "Şifremi unuttum" captcha göstermez; CAPTCHA açılırsa o akış çalışmaz. (Fonksiyonun "Daveti yeniden gönder" isteği service role ile gittiği için CAPTCHA'dan etkilenmez.)

## 5. Test

Ön kontrol (CORS). Bu istek gizli bilgi içermez:

```bash
curl -i -X OPTIONS https://knzrcgqpzjbajfboqlhq.supabase.co/functions/v1/invite-staff \
  -H "Origin: https://dentos-eight.vercel.app" \
  -H "Access-Control-Request-Method: POST"
```

Beklenen: `204` ve `access-control-allow-origin: https://dentos-eight.vercel.app`. `404` dönüyorsa fonksiyon kurulmamış veya adı farklıdır.

Uygulamadan:
1. Ekip → "+ Personel ekle" → e-posta olarak sahibin kontrol ettiği **ikinci** bir posta kutusunu girin → kaydedin.
2. Satırda "Davet gönder" → onaylayın → "Davet e-postası gönderildi." mesajı ve "Davet gönderildi · <zaman>" durumu.
3. E-postadaki bağlantıyı **gizli (private/incognito) pencerede** açın. Sayfa önce "Bu bağlantı <e-posta> hesabı içindir." diye sorar; sahibin oturum açık olduğu tarayıcıda açılırsa ayrıca "devam ederseniz bu oturum kapanır" uyarısı çıkar. "Devam et" denmeden hiçbir oturum değişmez.
4. "Devam et" → "Şifrenizi belirleyin" → şifreyi kaydedin → panel açılır. Ekip ekranında durum "Aktif · son giriş …" olur.
5. Test personelini "Düzenle" ile pasif yapın.

## 6. Sorun giderme

| Belirti / kod | Neden | Ne yapılmalı |
|---|---|---|
| `FN_CONFIG` "Davet servisi yapılandırması eksik" | 0027 uygulanmamış veya `SITE_URL` geçersiz (https olmalı, sonunda `/` olmasın) | Migration'ı çalıştırın; Edge Functions → Secrets'ta `SITE_URL`'i düzeltin veya silin |
| `FN_SEND_FAILED` "E-posta gönderilemedi" | SMTP hatası, gönderen adresi reddedildi | Authentication → Logs ve Edge Functions → invite-staff → Logs; SMTP kullanıcı adı/şifre/port ayarları |
| `FN_RATE_LIMIT` | Kısa sürede çok e-posta | Birkaç dakika bekleyin; gerekirse Authentication → Rate Limits |
| `PLT_EMAIL_IN_USE` | Bu e-posta ile zaten bir giriş hesabı var (fonksiyon güvenlik nedeniyle mevcut hesabı bağlamaz) | Hesap, yarım kalmış bir denemeden kalmışsa ve kimse kullanmıyorsa sahip Authentication → Users'tan silip yeniden davet edebilir; değilse farklı e-posta |
| `PLT_EMAIL_PLACEHOLDER` | Personelin e-postası geçici (`@dentos.local` vb.) | "Düzenle" ile gerçek e-postayı girin, sonra davet gönderin |
| Bağlantı "süresi dolmuş veya kullanılmış" | 24 saat geçti ya da e-posta güvenlik tarayıcısı bağlantıyı önceden açtı | Ekip → "Daveti yeniden gönder" (durum "Davet gönderildi" ise) |
| Ekip ekranında durum "Aktif · son giriş …" ama kişi şifre belirlemedi / giriş yapamıyor | Bağlantı açıldığı anda (kişi veya e-posta güvenlik tarayıcısı) hesap aktif sayılır; "Daveti yeniden gönder" artık sunulmaz (`PLT_ALREADY_ACTIVE`) | Kişi `/login` sayfasındaki "Şifremi unuttum" bağlantısını kullanır |
| `PLT_INVITE_FINANCE` / `PLT_EMAIL_FINANCE` | Personelin finans veya finans (salt okunur) yetkisi var; bu kişiyi yalnız klinik sahibi veya finans yetkilisi davet edebilir / e-postasını değiştirebilir | Klinik sahibi davet göndersin |
| Tarayıcı konsolunda CORS hatası | İstek izinli olmayan bir adresten geliyor (ör. Vercel preview) | Ana adresten (`dentos.klinikprimemaltepe.com` veya `dentos-eight.vercel.app`) deneyin; preview adresleri bilinçli olarak kapalı. Alan adından geliyorsa `SITE_URL` secret'ının o adres olduğunu kontrol edin |
| "Davet servisi bulunamadı …" veya "Davet servisine ulaşılamadı … invite-staff …" (uygulamada); tarayıcı konsolunda `CORS` / `Failed to fetch` | Fonksiyon kurulmamış, adı `invite-staff` değil, ya da gateway JWT doğrulaması token'ı reddetti (bu cevaplarda CORS başlığı olmadığı için tarayıcı bunu bağlantı hatası gibi gösterir) | Bölüm 5'teki `curl` ön kontrolü: `404` → Bölüm 3; `204` ise Bölüm 3 adım 4 (JWT doğrulaması) |
| `401` | Oturum süresi dolmuş, ya da gateway JWT doğrulaması yeni imza anahtarlarıyla uyumsuz | Yeniden giriş; sürerse Bölüm 3 adım 4 |

Fonksiyon logları yalnız işlem, hedef personel id'si ve hata kodlarını içerir; e-posta, ad veya token yazmaz.

## 7. Güncelleme ve geri alma

- Güncelleme: repodaki yeni `index.ts`'i dashboard editöründe mevcut kodun yerine yapıştırıp **Deploy** edin. Ad aynı (`invite-staff`) kalmalı.
- Davetleri geçici olarak kapatmak: fonksiyonu silin (Edge Functions → invite-staff → Delete). Uygulama bu durumda "Davet servisi bulunamadı …" gösterir; başka hiçbir şey bu fonksiyona bağlı değildir.

## 8. Güvenlik notları

- Service-role anahtarı yalnız fonksiyonun içinde (Supabase'in otomatik sağladığı ortam değişkeni olarak) bulunur; web uygulaması yalnız anon anahtarı kullanır.
- Fonksiyon hiçbir yanıtta anahtar, JWT, davet/şifre bağlantısı veya auth hesap kimliği döndürmez.
- Var olan bir giriş hesabı hiçbir zaman otomatik olarak personele bağlanmaz. Bağlama yalnız fonksiyonun bu çağrıda oluşturduğu hesap için, personel kaydı hâlâ bağlantısızsa, e-postalar aynıysa ve hesap henüz hiç kullanılmamışsa (şifresiz, e-postası onaylanmamış, hiç giriş yapılmamış) yapılır. Bağlama başarısız olursa fonksiyon yalnız bu çağrıda oluşturulduğu doğrulanan, kullanılmamış hesabı siler.
- Finans yetkisi olan bir personeli yalnız klinik sahibi veya finans yetkilisi davet edebilir; böyle bir personelin e-postasını da yalnız onlar değiştirebilir. Giriş hesabı olan personelin e-postası hiçbir yoldan değiştirilemez.
- Davet ve şifre bağlantıları tek kullanımlıktır; süresi Email OTP Expiration ayarıyla sınırlıdır. `/reset-password` bağlantıdaki hesabın e-postasını gösterip onay ister; başka birinin bağlantısı bu tarayıcıdaki oturumu sessizce değiştiremez. Bağlantısız açıldığında şifre formu gösterilmez.
- Fonksiyonun "deneme" (dry run) modu yoktur. Bilinen ve kabul edilen kalan durum: aktif bir sahip/yönetici, bağlantısız bir personelin e-postasını değiştirip "Davet gönder" dediğinde, adres projede (herhangi bir klinikte) zaten bir giriş hesabına aitse e-posta gönderilmeden `PLT_EMAIL_IN_USE` alır; yani bir adresin DentOS hesabı olup olmadığını öğrenebilir. Adres boştaysa gerçek bir davet e-postası gider ve denetim kaydı yazılır.
