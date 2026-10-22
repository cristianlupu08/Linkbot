# Bot de Telegram: postări LinkedIn din voce

## Cine sunt și cum lucrăm

- Sunt începător. Am mai făcut un proiect complet cu Claude Code (site și aplicație de cafenea cu Next.js, Supabase, Vercel, GitHub). Proiectul ăsta e o întrecere cu fratele meu, care lucrează în domeniu: câștigă botul mai util și mai plăcut de folosit.
- Lucrez pe Windows 11, din Command Prompt, cu VS Code, Node.js, Git și cont GitHub.
- Vorbește-mi în română, simplu. Explică pe scurt ce faci și de ce.
- **Proiectul e în engleză:** codul, comentariile, mesajele botului, butoanele, comenzile (`/new`, `/settings`, `/style`, `/ideas`, `/history`, `/drafts`, `/help`) și postările generate. Brieful de mai jos descrie textele în română, dar în bot le traducem în engleză. Doar discuția cu mine e în română.
- Lucrăm pe etape. Înainte de fiecare etapă, propune-mi un plan scurt și așteaptă confirmarea mea.
- Nu trece la etapa următoare până nu testez eu în Telegram și confirm că merge.
- După fiecare bucată care funcționează, propune-mi un commit cu un mesaj clar.
- Când am de făcut ceva manual (BotFather, Vercel, Supabase, chei API), dă-mi pașii exacți, unul câte unul.
- La finalul fiecărei sesiuni, actualizează secțiunea „Unde am rămas”.

## Ce construim

Un bot de Telegram. Utilizatorul îi trimite un **mesaj vocal** cu o poveste, iar botul îi dă înapoi, în chat, **postarea de LinkedIn scrisă, caruselul PDF și poza**. Nimic de instalat: totul se întâmplă în Telegram.

**Reguli fixe:**
- Botul **NU postează niciodată singur** pe LinkedIn. Doar pregătește materialul.
- Botul răspunde **doar utilizatorilor aprobați**. Restul primesc „Access restricted.” La început, aprobat sunt doar eu (ID-ul meu în `ALLOWED_TELEGRAM_IDS`).
- **Link de invitație:** la final vreau să-i trimit fratelui meu un link (`t.me/<bot>?start=<cod-secret>`). Când îl deschide, e aprobat automat și salvat în Supabase, fără să-i adaug ID-ul de mână. De făcut după ce intră Supabase.

## Conversația, pas cu pas

1. **/start**: bun venit în 3 rânduri și „Trimite-mi un vocal cu povestea ta”.
2. **Intrare:** vocal, fișier audio, text scris sau un mesaj redirecționat. Botul confirmă imediat („Am primit, transcriu…”) și arată „scrie…” cât lucrează.
3. **Transcriere:** botul arată textul înțeles, cu butoanele [E corect] și [Corectez]. La „Corectez”, utilizatorul trimite textul bun.
4. **Opțiunile: 3 ecrane, fiecare cu 3 rânduri de butoane.** Un rând = o întrebare, iar numele întrebărilor stau în textul mesajului. Botul editează același mesaj și pune ✓ pe ce s-a ales. Fiecare rând vine pre-bifat cu alegerea de data trecută. Pe primul ecran e și butonul [⚡ Ca data trecută], care sare direct la generare.
   - **Ecranul 1, Textul:** Ton [Serios][Amuzant][Inspirațional] · Lungime [Scurtă][Medie][Lungă] · Pentru [Recrutori][Colegi][Clienți]
   - **Ecranul 2, Caruselul:** Slide-uri [Fără][5][8] · Stil [Minimal][Colorat][Întunecat] · Structură [Poveste][Listă de sfaturi][Înainte/După]. Dacă s-a ales „Fără”, se sare peste celelalte două rânduri.
   - **Ecranul 3, Finisaje:** Poză [Generează AI][Trimit eu][Fără] · Emoji [Fără][Puține][Multe] · Final [Întrebare][Urmărește-mă][Fără]
   - La final: un rezumat al alegerilor, cu [Generează] și [Schimb ceva].
5. **3 variante de postare**, într-un **singur mesaj** care se răsfoiește cu `[◀] 1/3 [▶]` și `[Aleg asta]`. Botul editează mesajul, nu trimite mesaje noi, ca să nu fie nevoie de scroll.
6. **5 hook-uri** (variante de prim rând), ca butoane. Hook-ul ales înlocuiește primul rând.
7. **Rezultatul final:**
   - postarea, singură într-un mesaj, ca să fie ușor de copiat;
   - sub ea: numărul de caractere, nota (1–10) cu 1–2 sfaturi și locul unde LinkedIn taie cu „…vezi mai mult”;
   - caruselul ca fișier PDF, plus coperta ca imagine de previzualizare;
   - poza.
8. **Ajustări:** [Mai scurt] [Refă finalul] [Alt hook] [Mai puține emoji] [Altă poză] [Gata], sau instrucțiuni libere scrise („pune o cifră concretă la început”). Se schimbă doar partea cerută.
9. **Gata:** totul se salvează în istoric.

## Comenzi

- `/start`: bun venit
- `/nou`: începe o postare nouă și anulează ce era în lucru
- `/settings`: poza, numele și titlul de pe vizuale (totul rămâne în engleză, fără opțiune de limbă)
- `/stil`: utilizatorul trimite 2–3 postări vechi de-ale lui, iar botul îi învață stilul (vezi mai jos)
- `/idei`: când nu știi ce să povestești, botul îți pune 3 întrebări care scot o poveste
- `/istoric`: ultimele postări, cu buton să retrimită textul, PDF-ul și poza
- `/ciorne`: postările lăsate la jumătate
- `/ajutor`: cum se folosește și sfaturi pentru un vocal bun

## Ce face AI-ul (Claude)

- **3 variante** pe opțiunile alese: una directă, una mai personală, una mai scurtă.
- **Structura care merge pe LinkedIn:** moment concret → tensiune → întorsătură → lecție. Paragrafe scurte, mult spațiu alb.
- **Hook-uri** scurte (ideal sub 8 cuvinte), de tip curiozitate sau „fix opusul la ce te-ai aștepta”.
- **Detectarea „costului”:** dacă povestea e prea „roz”, botul întreabă „Ce te-a costat asta?” (bani, timp, greșeli) și adaugă răspunsul în postare.
- **Avertisment pentru link-uri:** „Mută link-ul în primul comentariu, altfel scade vizibilitatea.”
- **Să nu sune a AI:** fără clișee de genul „În lumea de azi”, „game-changer”, „Hai să vorbim despre”, „Iată de ce”; fără liniuțe lungi puse peste tot; fără concluzii motivaționale goale. Păstrează cuvintele și expresiile utilizatorului din vocal.
- **Stilul personal (/stil):** dacă utilizatorul a dat postări vechi, Claude scrie în stilul lui (lungimea frazelor, emoji, felul în care începe și încheie).
- **Fără invenții:** nu adaugă cifre, nume sau întâmplări care nu apar în poveste. Dacă lipsește ceva important, întreabă.

## Caruselul PDF

- AI-ul scrie **doar textul** slide-urilor. Codul îl așază pe un design (HTML/CSS) și îl exportă ca PDF. **Nu folosim AI de imagini pentru slide-uri cu text**, pentru că scrie literele greșit.
- Format portret 4:5 (1080 × 1350 px), maxim ~25–30 de cuvinte pe slide, text mare, numerotare (3/8) și o săgeată „→” spre următorul.
- Prima pagină e coperta (titlu mare = hook-ul, plus numele din /setari). Ultima e îndemnul ales la „Final”.
- Structurile: **Poveste** (copertă, moment, tensiune, întorsătură, lecții, îndemn) · **Listă de sfaturi** (copertă, un sfat pe slide, îndemn) · **Înainte/După** (copertă, cum era, ce s-a schimbat, cum e acum, lecția, îndemn).
- 3 stiluri vizuale: Minimal, Colorat, Întunecat.

## Poza

Generată de AI pe baza poveștii, **fără text în imagine**, sau trimisă de utilizator în chat, sau fără poză. Butonul [Altă poză] generează altă variantă.

## Stack

- **Telegram Bot API:** botul se creează la @BotFather; mesajele vin prin webhook.
- **Next.js pe Vercel:** ruta de webhook și toată logica. Fără interfață web, doar botul.
- **Supabase:** utilizatori aprobați, setări, stil, starea conversației, istoric, ciorne.
- **API Anthropic (Claude):** textul (variante, hook-uri, slide-uri, notă).
- **API OpenAI:** transcrierea vocalului și generarea pozei.
- **Generator PDF** pentru carusel. Propune-mi tu varianta cea mai simplă care merge pe Vercel.
- GitHub pentru cod, Claude Code pentru dezvoltare.

## Note tehnice importante

- **Secrete:** token-ul botului și cheile API stau doar în `.env.local` (care e în `.gitignore`) și în setările Vercel. Niciodată în cod sau pe GitHub.
- **Webhook securizat:** setează `secret_token` la webhook și verifică header-ul `X-Telegram-Bot-Api-Secret-Token`. Ignoră orice altă cerere.
- **Răspuns rapid:** webhook-ul răspunde imediat cu 200, iar munca lungă (transcriere, AI, PDF) se face după răspuns. Altfel Telegram retrimite mesajul și se generează de două ori. Ține și evidența `update_id`-urilor deja procesate.
- **Starea conversației** (la ce pas e fiecare utilizator, ce a ales) se ține în Supabase, nu în memorie, pentru că pe Vercel memoria nu se păstrează între cereri.
- **Limite Telegram:** `callback_data` maxim 64 de bytes (folosește coduri scurte); un mesaj maxim 4096 de caractere; o descriere de fișier maxim 1024; botul poate descărca fișiere de maxim 20 MB.
- **Vocale:** vin ca OGG. Limită rezonabilă: ~5 minute. La vocale mai lungi, botul spune politicos să fie scurtat.
- **Erori prietenoase:** dacă un serviciu AI pică, botul spune „Ceva n-a mers, încerc din nou?” cu un buton [Reîncearcă]. Utilizatorul nu vede niciodată erori tehnice.
- **Costuri:** salvează în Supabase costul aproximativ al fiecărei generări. Am pus limite de cheltuieli în conturile Anthropic și OpenAI.

## Etape

1. **Botul viu:** botul creat la BotFather, proiect Next.js, GitHub, deploy pe Vercel, webhook securizat, lista de acces, /start. Botul răspunde la un mesaj scris.
2. **Esențialul:** vocal → transcriere → [E corect]/[Corectez] → ecranul 1 de opțiuni → 3 variante cu ◀ ▶ → postarea finală.
3. **Ce impresionează:** ecranele 2 și 3, rezumatul, hook-urile, caruselul PDF cu previzualizare, nota, numărul de caractere.
4. **Lustruirea:** poza, butoanele de ajustare și instrucțiunile libere, /setari, /istoric, „costul”, avertismentul pentru link-uri, „Ca data trecută”.
5. **Bonus:** /stil, /idei, /ciorne, statistica de costuri.

## Unde am rămas

(Actualizează la finalul fiecărei sesiuni: ce s-a terminat, ce nu merge încă, care e următorul pas.)

- **22.10.2026, etapa 1 terminată și testată în Telegram.** Bot: @linkbot_cristi_bot. Live: https://linkbot-ten.vercel.app (Vercel legat de github.com/cristianlupu08/Linkbot, deploy automat la push). Webhook securizat la `/api/telegram` (răspunde imediat, munca în `after()`), acces doar pentru ID-ul meu (`ALLOWED_TELEGRAM_IDS`), /start prietenos, iar la text liber răspunde natural prin Claude (`src/lib/ai.ts`, fără memorie între mesaje deocamdată).
- De făcut la final de etapă: token nou de bot (@BotFather → /revoke), pentru că cel vechi a apărut într-un screenshot. Se pune în `.env.local` și în Vercel.
- Amânat pentru etapa 2 (când intră Supabase): evidența `update_id`-urilor, memoria conversației, link-ul de invitație, butonul [Retry] la erori.
- **22.10.2026, etapa 2 (cod scris, netestat în Telegram):** Supabase (`supabase/schema.sql`: users, sessions, processed_updates, chat_messages, posts), vocal/fișier audio → transcriere OpenAI `gpt-transcribe` (`src/lib/transcribe.ts`) → [Looks right]/[Let me fix it] → ecranul 1 de opțiuni (`src/lib/options.ts`, pre-bifat cu alegerile de data trecută) → 3 variante cu ◀ ▶ (`generateVariants` în `src/lib/ai.ts`, JSON structurat) → postarea finală singură + numărul de caractere. Plus: /new, /help, memorie în chat, text lung → „Make it a post?”, mesaj redirecționat = poveste, [Try again] la erori, cost aproximativ salvat pe postare, link de invitație (`INVITE_CODE`).
- Etapa 2 testată în Telegram: merge cap-coadă.
- **22.10.2026, etapa 3 (live, testată automat, netestată de mine în Telegram):** 3 ecrane de opțiuni + rezumat + [⚡ Same as last time] (`src/lib/options.ts`), 5 hook-uri după alegerea variantei, nota 1–10 cu sfaturi, „ce se vede înainte de …see more”, avertisment pentru link-uri, carusel PDF (`src/lib/carousel.tsx`: slide-uri randate cu `next/og`, lipite în PDF cu `pdf-lib`, fonturi în `assets/fonts`) cu copertă ca previzualizare, poză AI (`src/lib/image.ts`, `gpt-image-2`, portret, fără fețe ale povestitorului) cu [Another image]. Cost: ~7 cenți pe postare cu carusel.
- **Decizii față de brief:** LinkedIn nu permite PDF și poză pe aceeași postare, deci ecranul 2 are rândul „Visual” [5 slides][8 slides][Image][None] în loc de „Slide-uri” + rândul „Poză” de pe ecranul 3. „Trimit eu poza” a fost scos (o pui direct pe LinkedIn). Ecranul 3 are doar Emoji și Ending.
- **22.10.2026, îmbunătățiri după analiza exemplelor de pe LinkedIn (live, testate automat):** /settings cu poză, nume și titlu (poza apare pe copertă, în subsol și pe ultimul slide); format nou „Quote card” (Visual: Carousel / Quote card / Image / None, plus rând separat pentru numărul de slide-uri); utilizatorii care revin sar direct la rezumat; mesaje de progres; primul comentariu gata scris; ajustări după final ([Shorter] [New ending] [Other hook] [Fewer emoji] [Done] sau instrucțiuni scrise). Coloana nouă `users.profile` trebuie adăugată în Supabase (vezi `supabase/schema.sql`).
- **Idei rămase pe listă:** culoare de brand în /settings, slide cu cifră mare, titlu de document la PDF (acum e sugerat din hook).
- **22.10.2026, a doua rundă de îmbunătățiri (live, testate automat):** bară de progres pe slide-uri + cifre mari la structura „Tips”; /ideas (3 întrebări care scot o poveste); /history (ultimele 5 postări, retrimise prin file_id salvat în `posts.meta.visual`); [⏰ Remind me tomorrow morning] + cron zilnic la 06:00 UTC (`/api/cron/reminders`, protejat cu `CRON_SECRET`); /banner (banner de profil 1584×396 în 3 stiluri, cu 3 texte propuse).
- **Decizie:** totul rămâne în engleză (fără opțiune de limbă română).
- **Onboarding (live, testat):** la primul /start, configurare ghidată (titlu de job, poză, ambele cu [Skip]), sfaturi după prima postare, descrierea botului setată prin `set-webhook`. Link de invitație verificat pe Vercel: `t.me/linkbot_cristi_bot?start=<INVITE_CODE>`.
- **22.10.2026, flux nou (live, AI testat separat, fluxul complet netestat în Telegram):** după confirmarea poveștii, interviu adaptiv de până la 3 întrebări (miza/„ce te-a costat”, de ce, detalii concrete), cu [Skip question] și [Enough, continue]; abia apoi opțiunile și generarea. La final, un editor AI curăță postarea (fără să schimbe primul rând) în loc să afișeze sfaturi; rămâne nota și, opțional, o singură întrebare „To make it stronger”. Plus: ton profesional în toate mesajele, /style (stil învățat din 2–3 postări vechi), /drafts, /costs.
- **22.10.2026, vizualul se alege după text (live, testat cap-coadă):** opțiunile dinainte de scris sunt doar pentru text (ton, lungime, public, emoji, final). După ce alegi varianta și primul rând: meniu [Carousel (PDF)] [Image] [Quote card] [No visual]. Image = [Upload my own] sau [Create one]: descrii imaginea (vocal/text) sau ceri o sugestie, botul pune până la 2 întrebări, arată planul („I'll create: …”) și generează doar după confirmare, în stil foto realist (`REALISM` în `src/lib/image.ts`). La final, [Change visual] schimbă doar vizualul.
- **Decizie:** poveștile pot fi despre orice (muncă, sport, călătorii, familie), nu doar de la muncă. Mesajele botului și instrucțiunile AI nu mai presupun că e vorba de job.
- **Formatare LinkedIn:** reguli în `POST_SYSTEM` (hook în primele ~140 de caractere vizibile pe mobil, paragrafe de 1–3 propoziții cu un rând liber, ritm variat, nu fiecare propoziție pe rândul ei, liste cu → sau 1., 3–5 hashtag-uri pe ultimul rând, fără markdown) + `formatForLinkedIn()` care normalizează spațiile după fiecare generare/editare.
- **Poze în carusel (live):** după stil/structură, „Photos in your carousel?” → [Use my photos] (1–4, album acceptat, salvate în tabelul `post_photos`) / [Create photos for me] (botul propune 2–3 poze din poveste, le poți descrie, poate pune o întrebare, apoi le creează realist, 1536×1024) / [Text only]. Prima poză merge pe copertă, restul pe slide-urile din mijloc (`photoSlots`). Slide-urile trebuie să fie specifice poveștii, nu sfaturi generice.
- **Previzualizare în feed (live):** la final (și la [Change visual]) botul trimite o imagine cu postarea așa cum arată pe LinkedIn pe telefon: poza, numele, titlul, textul tăiat după ~3 rânduri cu „…more”, vizualul (coperta caruselului cu bara „titlu · N pages”) și bara Like/Comment/Repost/Send (`renderFeedPreview` în `src/lib/carousel.tsx`). Pozele proprii în carusel testate și ca album (3 deodată).
- **Control general (22.10.2026):** test complet ca utilizator nou + comenzi. Reparat: poze trimise ca fișier acceptate; poză trimisă direct în meniul de vizual = poza postării; lacăt atomic contra dublu-tap (`tryLockSession`); pozele create pentru carusel păstrate în Supabase Storage (bucket privat `carousel-photos`) și refolosite la ajustări de text; „Skip” vechi ignorat.
- **Următorul pas:** testare de către mine în Telegram; idei rămase: culoare de brand, slide cu cifră mare.
