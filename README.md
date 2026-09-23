# Futmancos com Supabase

O cadastro, login, confirmação de e-mail e perfil dos jogadores usam Supabase Auth e Postgres. O código de ADM é validado por uma função SQL protegida. A API Node sincroniza o perfil Supabase após o login e mantém o status das mensalidades. O pagamento é feito por Pix fora do site: o associado envia o comprovante pelo WhatsApp e um ADM confirma manualmente no painel.

## Configuração inicial do Supabase

1. Abra o projeto `tsncbzqjyhzubwczyijv` no Supabase.
2. Entre em **SQL Editor**, crie uma consulta, cole todo o arquivo `supabase/migrations/202609230001_profiles_and_admin_invites.sql` e clique em **Run**.
3. Em **Authentication > URL Configuration**, adicione `http://localhost:3000` e o domínio público do site como URLs permitidas de redirecionamento.
4. Se a confirmação de e-mail estiver ativada, configure o envio de e-mails do Supabase Auth. O envio de código ADM por e-mail não é usado neste fluxo.

A URL e a chave `anon` já estão no HTML. A chave anon é pública e protegida pelas políticas RLS e permissões SQL da migração. Não coloque uma chave `service_role` no site.

## Código ADM

No cadastro, selecione “Conta de administrador (com código)” e digite o código compartilhado `8630`. Depois da confirmação de e-mail e do login, o Supabase valida o código e marca o perfil como ADM. Cinco tentativas incorretas bloqueiam novas tentativas daquela conta por 30 minutos. Qualquer pessoa que conheça o código pode solicitar acesso ADM, então compartilhe-o somente com pessoas autorizadas. Para trocar o código no futuro, altere o valor `8630` no arquivo da migração e execute novamente a migração atualizada no SQL Editor.

## Iniciar o site e a API

No servidor Node, copie `.env.example` para `.env`; mantenha `SUPABASE_URL` e `SUPABASE_ANON_KEY` iguais aos valores públicos do projeto. Preencha também `SESSION_SECRET`.

O ADM configura a chave Pix e carrega o QR Code em **Painel ADM > Configurar Pix da Associação**. A imagem deve ser PNG, JPG ou WebP com até 650 KB. O servidor grava esses dados no SQLite e os mostra aos associados na área Mensalidades. O número de WhatsApp da administração pode ser alterado em `WHATSAPP_ADMIN`.

Instale as dependências e inicie a aplicação (`npm install`, depois `npm start`). Abra `http://localhost:3000`, não o arquivo diretamente com `file://`. Para uso público, hospede a aplicação em HTTPS e adicione o domínio à lista de redirecionamentos do Supabase.

## Dados compartilhados entre dispositivos

As contas e a autenticação ficam no Supabase. O servidor Node mantém a cópia central dos dados da associação no SQLite: lista e perfis dos jogadores, partidas e resultados, presença e check-in, votações, estatísticas, mensalidades e confirmações de pagamento, chave Pix e QR Code, arenas e próximo baba. As fotos de perfil também são enviadas ao servidor. O navegador consulta atualizações periodicamente (a cada 20 segundos) e mantém uma cópia local para carregar a interface.

Para que vários celulares e computadores compartilhem os mesmos dados, todos devem acessar a aplicação hospedada no mesmo servidor HTTPS e com o mesmo projeto Supabase. Abrir o HTML diretamente como arquivo ou usar servidores locais diferentes não compartilha as informações. A API e o SQLite precisam permanecer disponíveis; faça cópias de segurança regulares do arquivo do banco.

Um ADM confirma a mensalidade como paga após conferir o comprovante Pix. Presenças, check-ins e votos são gravados no servidor para o usuário autenticado. Se a API estiver indisponível, ações que dependem dela exibem erro e não são consideradas confirmadas.


