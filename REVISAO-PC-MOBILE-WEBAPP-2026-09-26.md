# Revisão do site — PC, celular e web app

## Escopo verificado

- Revisão visual local da página pública em desktop (1440 × 900) e mobile (390 × 844).
- Conferência de largura/rolagem nos viewports 320, 360, 390, 768, 1024 e 1440 px.
- Navegação e aparência das telas Resenha, Início, cadastro de convidado, criação de conta e modal de login.
- Revisão estática dos módulos autenticados: Perfil, Cartinhas, Plano de Jogo, Central Baba, Mancos League, Mensalidades e Painel ADM.
- Leitura do manifesto PWA, cache/offline e comportamento de safe area da navegação móvel.
- Validação sintática de `server.js` e dos dois blocos JavaScript inline. Nenhum fluxo de cadastro, pagamento ou escrita no Supabase foi enviado.

## Ajustes feitos nesta revisão

1. Alinhei o ícone do título “Top 3” no celular para ele acompanhar a primeira linha do texto.
2. O cadastro agora exige que o associado escolha sua posição. Antes, “Goleiro” vinha selecionado por padrão, o que poderia conceder isenção de mensalidade sem intenção.
3. Removi funções antigas de registro manual que já não tinham tela e eram chamadas durante as sincronizações, além de seletores antigos sem campos correspondentes. O fluxo atual de sorteio e fechamento de resultados permanece.
4. Atualizei a versão do cache do service worker para fazer os dispositivos receberem os arquivos novos.

## Resultados

- Nenhuma rolagem horizontal foi encontrada nos tamanhos verificados.
- O cabeçalho, os formulários públicos, o modal de login e a navegação responsiva aparecem corretamente nos testes visuais.
- No fim do formulário de cadastro, os botões ficam acessíveis acima da barra fixa inferior.
- O manifesto define exibição standalone e orientação retrato. A página inclui `viewport-fit=cover` e adapta a área segura da navegação inferior.
- Não encontrei IDs estáticos duplicados nem handlers inline simples sem função correspondente.
- Os scripts inline e o servidor passaram pela validação de sintaxe JavaScript.

## Itens recomendados para uma próxima etapa

1. **Desempenho inicial:** Tailwind via CDN e bibliotecas externas (ícones, gráficos, Supabase e fontes) são carregados pelo navegador. Empacotar dependências localmente e carregar o módulo de gráficos só quando necessário reduziria dependência de rede e trabalho inicial, mas requer uma etapa de build e validação própria.
2. **Sincronização:** a página consulta dados em ciclos de 20 e 30 segundos; junto do estado compartilhado grande em JSON, isso pode elevar tráfego e latência conforme aumenta o uso. A análise detalhada está em `ANALISE-DE-PERFORMANCE.md`.
3. **Validação integrada:** telas que dependem de autenticação e permissões (perfil, mensalidades, liga e ADM) foram revisadas no código, mas não foram operadas contra uma conta e banco reais nesta revisão. Para validar esses fluxos de ponta a ponta, é necessário testar com usuários de cada papel no ambiente Supabase correto.

## Limites

Esta foi uma inspeção visual e estática local. Não houve auditoria de Lighthouse, medição de rede em condições móveis, execução de pagamentos, cadastro real, gravações de resultados nem teste de notificações push. O teste local serviu os arquivos estáticos; os dados e rotas de API reais não foram alterados.
