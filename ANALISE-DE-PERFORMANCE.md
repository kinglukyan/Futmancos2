# Análise de desempenho e confiabilidade

## Escopo

Revisão estática de `public/index.html`, `server.js` e das migrações atuais do Supabase. Não foi feita medição com tráfego real nem execução de `EXPLAIN ANALYZE`; por isso, os itens abaixo são gargalos identificados no desenho do código, e não tempos de resposta medidos.

## O que a migração SQL melhora

O arquivo `supabase/migrations/202609250010_query_performance.sql` adiciona índices para:

- ordenação dos associados por nome e verificação de número da camisa;
- consultas e exclusões em cascata por associado nas tabelas de presença, votos, convidados e notificações;
- listagem de convidados mais recentes primeiro;
- localização do responsável em registros de auditoria.

Ele também remove quatro índices simples redundantes que duplicavam o prefixo de índices únicos já existentes. Os índices únicos e os dados permanecem. A migração atualiza as estatísticas que o planejador do Postgres usa.

## Gargalos que exigem mudança na aplicação

1. **Estado compartilhado concentrado em um JSON grande.** `app_state.state_json` agrupa elenco, histórico, transações, configurações, campeonato e planos. A API lê e grava esse documento inteiro em várias operações. Conforme cresce, cada atualização transfere/processa mais dados; atualizações simultâneas também podem sobrescrever mudanças feitas por outra pessoa entre a leitura e a gravação. Um índice não resolve esse custo. Recomendo migrar gradualmente cada domínio para tabelas próprias e fazer atualizações atômicas no banco.

2. **Sincronização frequente e com várias chamadas.** A página repete sincronizações a cada 20 segundos e consulta a liga a cada 30 segundos. O ciclo compartilhado carrega estado, partidas, presença, modo da Central, sorteios, votos e situação financeira. Isso aumenta tráfego, trabalho no servidor e uso de bateria mesmo quando os dados não mudaram. Próxima melhoria: sincronizar apenas a aba ativa, pausar quando a página estiver oculta e usar Supabase Realtime ou uma versão (`updated_at`) para buscar mudanças somente quando necessário.

3. **Listagens sem paginação.** Partidas, convidados e associados são retornados em listas completas; o log de auditoria pode retornar até 1.000 registros de uma vez. O índice ajuda a localizar/ordenar, mas não reduz o tamanho da resposta. Próxima melhoria: paginação por cursor e filtros por período, com limites menores.

4. **Montagem do estado compartilhado faz busca repetida no elenco.** Ao combinar perfis com o JSON, o servidor procura cada perfil percorrendo o elenco. Isso cresce aproximadamente com o produto do número de associados pelo tamanho do elenco. Criar um mapa por ID/e-mail antes do laço torna a montagem linear.

5. **Hospedagem pode adicionar espera inicial.** O README documenta que o serviço Render gratuito pode dormir. SQL e índices não removem o tempo de inicialização a frio; isso depende do plano/configuração do serviço e da arquitetura da API.

## Sequência recomendada

1. Aplicar a migração SQL em janela de baixo uso. Ela não exclui registros; criar índices consome CPU e I/O temporariamente.
2. Medir consultas no Supabase (Database > Query Performance / `pg_stat_statements`) antes e depois. Índices não usados podem ser removidos depois de observar tráfego real.
3. Refatorar listagens grandes para paginação e dividir o JSON compartilhado por domínio, com gravações transacionais/atômicas.
4. Reduzir e condicionar a sincronização no navegador; depois avaliar Realtime.

## Limitações e segurança

A migração mantém as políticas RLS, permissões e regras de negócio existentes; não afrouxa acesso. Ela pressupõe que as migrações atuais da aplicação já foram aplicadas. Como não foi executada no projeto Supabase, confirme que o banco selecionado é o projeto correto antes de rodá-la.
