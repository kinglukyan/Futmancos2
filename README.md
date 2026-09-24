# Futmancos

O site usa Supabase Auth para cadastro e login. O Supabase Postgres guarda os perfis e todos os dados compartilhados da associação. O servidor Node fornece a API e pode rodar no Render gratuito; não depende de SQLite, arquivo local ou sessão guardada no servidor.

## Preparar o Supabase

No projeto `tsncbzqjyhzubwczyijv`, abra **SQL Editor** e execute estes arquivos, nesta ordem:

1. `supabase/migrations/202609230001_profiles_and_admin_invites.sql` (se ainda não executou).
2. `supabase/migrations/202609240001_shared_app_data.sql`.
3. `supabase/migrations/202609240002_player_shirt_number.sql` (se ainda nÃ£o executou).
4. `supabase/migrations/202609240003_gallery.sql` (cria o bucket pÃºblico de leitura; envio e exclusÃ£o ficam restritos a ADM pela API).
5. `supabase/migrations/202609240004_guests_and_guest_fees.sql` (convidados, presença/check-in e configurações de valores).
6. `supabase/migrations/202609240005_draws_codes_push.sql` (códigos de convite, sorteios persistentes e notificações push).

A segunda migração adiciona mensalidades e fotos aos perfis e cria as tabelas de configurações Pix, dados gerais, presença, check-in, votos e partidas. Ela não apaga dados existentes.

O código ADM é validado pela função `promote_futmancos_admin`; no cadastro, o código atual é `8630`. Em **Authentication > URL Configuration**, mantenha o endereço da Vercel nas URLs permitidas de redirecionamento.

## Publicar o backend no Render

Conecte o repositório do GitHub como **Web Service**. Use:

- Build command: `npm install`
- Start command: `npm start`
- Root directory: vazio
- Health check path: `/api/health`

Adicione estas variáveis de ambiente no Render:

- `SUPABASE_URL`: URL do projeto Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: chave secreta de servidor do Supabase (em projetos antigos aparece como `service_role`). Copie-a em **Supabase > Project Settings > API Keys**. Guarde-a somente no Render: nunca no HTML, GitHub ou neste chat.
- `WHATSAPP_ADMIN`: número com código do país, apenas dígitos, por exemplo `5575998572594`.
- `MONTHLY_FEE`: valor inicial da mensalidade, por exemplo `50.00`.

Não configure `DATABASE_FILE`, `SESSION_SECRET` nem disco persistente: os dados e a autenticação são mantidos no Supabase. A chave `anon` continua pública e é usada pelo HTML para o Supabase Auth.

## Ligar o site da Vercel à API

O HTML chama os caminhos `/api/...` no domínio da Vercel. Depois que o Render publicar o backend e fornecer o endereço `onrender.com`, configure uma reescrita `/api/:path*` no projeto Vercel apontando para `https://SEU-BACKEND.onrender.com/api/:path*`. Sem essa ligação, o HTML pode carregar, mas as funções administrativas receberão erro 404.

## Dados compartilhados

Os dados salvos no Supabase incluem perfis, mensalidades e confirmações de pagamento, chave Pix e QR Code, arenas, próximo baba, presença, check-in, partidas, resultados, votações e fotos de perfil. As contas continuam sendo autenticadas pelo Supabase Auth. O navegador sincroniza atualizações periodicamente.

No Render gratuito, o serviço pode levar aproximadamente um minuto para responder após 15 minutos sem tráfego; os dados permanecem no Supabase.


## Convidados e valores

O cadastro de convidados não cria conta. O CPF é criptografado pelo servidor e mostrado aos administradores somente com os últimos dígitos. Quem convidou e os ADMs podem marcar presença e check-in no baba. Convidados ficam fora das estatísticas oficiais, avaliações e cartinhas.

Na tela ADM, defina mensalidade, diária de convidado e contribuição de referência dos goleiros (para custos de churrasco/confra). A exclusão de transações exige conta ADM e código de administração (8630 por padrão; se ADMIN_DELETE_CODE estiver configurado no Render, use o valor definido ali).


## Códigos, sorteios e avisos no celular

A migração 202609240005_draws_codes_push.sql cria um código aleatório individual de seis dígitos para cada perfil existente e gera o código dos próximos cadastros. O associado encontra o código em Perfil; o convidado informa esse código no cadastro. Execute também esta migração no Supabase.

Na Central Baba, ADM escolhe a quantidade de jogadores com check-in, sorteia times balanceados pelo OVR e salva cada sorteio. Jogadores que ainda não saíram em sorteios daquele dia têm prioridade. Cada time tem um goleiro: os goleiros confirmados aparecem pré-selecionados; se faltar algum, o ADM escolhe outro jogador para assumir a posição. Ao final dos jogos, preencha gols, assistências, defesas e vencedor de cada sorteio; só depois encerre o dia para abrir a votação.

Para gerar as chaves VAPID, com Node.js instalado, abra a pasta `scripts` e dê dois cliques em `gerar-vapid.bat`. Copie as três linhas exibidas em **Environment** no Render. Não publique nem compartilhe `VAPID_PRIVATE_KEY`; mantenha essas chaves entre as publicações. Depois instale o app no celular, entre na conta, abra **Perfil** e toque em **Ativar avisos neste aparelho**. Os avisos incluem baba novo, dia do baba, mensalidade pendente/atrasada e abertura da votação.

No Render gratuito, o servidor pode dormir quando não recebe acessos. Eventos acionados por ações no site (novo baba, votação e pagamento) são enviados quando ocorrem; lembretes de data e mensalidade dependem de o serviço estar acordado no horário da verificação.
