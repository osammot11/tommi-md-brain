# Deploy su IONOS: Ubuntu 24.04

Questa guida usa l’utente `deploy`, systemd, Node.js 22 già installato e Nginx già in uso per `brain.produceavalue.com`. Le porte 3000 e 3100 sono occupate da altre app: Brain userà la 32147, dopo aver verificato che sia libera. Esegui i comandi sulla VPS via SSH come `deploy`, salvo dove è indicato il pannello DNS. Non copiare la cartella locale `data` né il file `.env` nel repository.

## 1. Controlli iniziali

```bash
whoami
sudo -v
cat /etc/os-release
node --version
command -v node
sudo ss -ltnp | grep -E ':(80|443|3000|3100|32147)\b' || true
sudo ufw status
```

`whoami` deve stampare `deploy`. Nginx usa già le porte 80/443; altre app usano la 3000 e la 3100. La porta 32147 deve risultare libera prima di continuare. Mantieni i siti e i servizi esistenti.

## 2. DNS

Nel pannello del provider che gestisce il DNS di `produceavalue.com`, aggiungi o modifica un record **A** con host `brain` e indirizzo IPv4 pubblico della VPS. Elimina eventuali record A/AAAA per `brain` che puntano altrove. Crea un record AAAA solo se hai IPv6 configurato sulla VPS. Dal server verifica:

```bash
getent ahostsv4 brain.produceavalue.com
```

Deve apparire l’IPv4 pubblico della VPS. La propagazione DNS può richiedere tempo.

## 3. Node.js e Git

Sulla VPS è già disponibile Node.js 22.22.3 in `/usr/local/bin/node`, compatibile con il progetto. Verifica che Git sia installato:

```bash
git --version
```

Se Git manca, installalo con `sudo apt update` e `sudo apt install -y git`. Il servizio incluso usa `/usr/local/bin/node`. Non serve `npm install`: il progetto non ha dipendenze npm.

## 4. Codice, dati e credenziali

```bash
sudo install -d -o deploy -g deploy -m 755 /opt/tommi-brain
git clone https://github.com/osammot11/tommi-md-brain.git /opt/tommi-brain
sudo install -d -o deploy -g deploy -m 700 /var/lib/tommi-brain /var/lib/tommi-brain-backups
sudo touch /etc/tommi-brain.env
sudo chown root:root /etc/tommi-brain.env
sudo chmod 600 /etc/tommi-brain.env
sudo nano /etc/tommi-brain.env
```

Inserisci nel file le righe seguenti. Sostituisci la password con una password lunga e unica; genera la chiave di sessione con `openssl rand -hex 32`. Non inviare questi valori in chat e non usare gli esempi letteralmente.

```ini
BRAIN_PASSWORD=LA_TUA_PASSWORD_LUNGA_E_UNICA
BRAIN_SESSION_SECRET=LA_CHIAVE_CASUALE_GENERATA
BRAIN_DATA_DIR=/var/lib/tommi-brain
BRAIN_BACKUP_DIR=/var/lib/tommi-brain-backups
BRAIN_BACKUP_RETENTION=7
PORT=32147
BRAIN_SECURE_COOKIE=1
```

L’app non accetta la password di esempio né una chiave di sessione inferiore a 32 caratteri. Usa una password senza spazi, virgolette o caratteri speciali interpretati dal formato `EnvironmentFile`; in alternativa chiedi aiuto per verificare l’escaping.

## 5. Servizio systemd

```bash
sudo cp /opt/tommi-brain/deploy/tommi-brain.service /etc/systemd/system/tommi-brain.service
sudo systemctl daemon-reload
sudo systemctl enable --now tommi-brain
sudo systemctl status tommi-brain --no-pager
curl -I http://127.0.0.1:32147/
```

Il test locale deve dare `HTTP/1.1 200 OK`. Se il servizio fallisce, leggi `sudo journalctl -u tommi-brain -n 80 --no-pager`. La porta 32147 deve restare chiusa verso Internet; Node ascolta solo su `127.0.0.1`.

## 6. Nginx e HTTPS

Questa VPS usa già Nginx: aggiungi un sito senza sostituire le configurazioni degli altri. Controlla prima che `brain.produceavalue.com` non sia già configurato:

```bash
sudo nginx -T 2>&1 | grep -F 'server_name brain.produceavalue.com' || true
```

Se non esiste già, installa solo il nuovo file e convalida l’intera configurazione prima del reload:

```bash
sudo cp /opt/tommi-brain/deploy/brain.nginx.conf /etc/nginx/sites-available/brain.produceavalue.com
sudo ln -s /etc/nginx/sites-available/brain.produceavalue.com /etc/nginx/sites-enabled/brain.produceavalue.com
sudo nginx -t
sudo systemctl reload nginx
curl -I -H 'Host: brain.produceavalue.com' http://127.0.0.1/
```

L’ultimo comando deve dare `HTTP/1.1 200 OK`. Le porte 80/443 sono già permesse da UFW con `Nginx Full`. Se c’è anche un firewall nel pannello IONOS, verifica che consenta il traffico sulle stesse porte. Attendi che il DNS A risolva all’IP della VPS prima di chiedere il certificato.

Se Certbot è già installato e gestisce i certificati degli altri siti, usa quello esistente. Esegui:

```bash
sudo certbot --nginx -d brain.produceavalue.com
sudo nginx -t
sudo systemctl reload nginx
```

Se Certbot non è installato, installalo seguendo le [istruzioni ufficiali per Nginx](https://certbot.eff.org/instructions?ws=nginx&os=snap), poi esegui lo stesso comando. Scegli il reindirizzamento HTTP → HTTPS quando richiesto. Non eseguire Certbot finché il DNS non punta alla VPS.

## 7. Verifica e aggiornamenti

```bash
curl -I https://brain.produceavalue.com/
sudo systemctl status tommi-brain nginx --no-pager
```

Apri `https://brain.produceavalue.com` nel browser e accedi con la password impostata. Per aggiornare il codice:

```bash
cd /opt/tommi-brain
git pull --ff-only
sudo systemctl restart tommi-brain
```

I dati e i backup restano in `/var/lib`, separati dal codice. Il backup locale automatico non protegge da perdita della VPS: prepara anche una copia periodica fuori dal server.
