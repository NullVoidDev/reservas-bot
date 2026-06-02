# Plano de Melhorias — ReservasCMC

## Visão Geral

Bot WhatsApp para gestão de reservas do Clube Militar de Cáceres.
Stack: `whatsapp-web.js` + Express + JSON (banco de dados em arquivo).

---

## 🔴 Correções de Bug (Prioridade Máxima)

### BUG-01 — Cancelamento sem verificação de dono
- **Arquivo:** `src/handler.js` linha ~186
- **Problema:** Qualquer pessoa que souber o código pode cancelar a reserva de outra pessoa.
- **Correção:** Comparar `message.author || message.from` com `reserva.numero` antes de cancelar.

### BUG-02 — Nenhum feedback quando formulário de reserva está incompleto
- **Arquivo:** `src/handler.js` linha ~125
- **Problema:** Se o usuário esquecer um campo, o bot silencia completamente.
- **Correção:** Identificar qual(is) campo(s) estão faltando e retornar mensagem detalhada.

### BUG-03 — Geração de código com colisão potencial
- **Arquivo:** `src/handler.js` linha ~127
- **Problema:** `reservas.length + 1` pode gerar duplicatas se registros forem deletados/editados.
- **Correção:** Usar `Math.max(...codigos_existentes) + 1` para garantir unicidade.

### BUG-04 — Race condition na escrita do JSON
- **Arquivo:** `src/handler.js` funções `loadDB/saveDB`
- **Problema:** Duas mensagens simultâneas podem ler o JSON antes de qualquer uma salvar, sobrescrevendo dados.
- **Correção:** Implementar fila assíncrona (mutex simples com Promise) para serializar escritas.

### BUG-05 — `fetch` sem tratamento de erro no frontend
- **Arquivo:** `public/reservas.html` linha ~372
- **Problema:** Falha de rede quebra a página silenciosamente.
- **Correção:** try/catch com mensagem de erro visível para o usuário.

### BUG-06 — XSS via `innerHTML` com dados do usuário
- **Arquivo:** `public/reservas.html` linha ~332
- **Problema:** Campos `r.local`, `r.nome` etc. são inseridos via innerHTML sem escape — vetor de XSS.
- **Correção:** Criar função `escapeHtml()` e usar `textContent` ou escapar antes de inserir no DOM.

### BUG-07 — Reservas "Avisado" somem das listagens mas ainda bloqueiam conflito
- **Arquivo:** `src/handler.js`
- **Problema:** Status "Avisado" não é tratado uniformemente — some do `listar reservas` mas deveria ser tratado como "Reservado" para efeitos de conflito.
- **Correção:** Normalizar: "Avisado" = confirmado, aparece em listagens como tal.

### BUG-08 — Monitor de memória não seta `isReconnecting` antes de destruir
- **Arquivo:** `index.js` linha ~168
- **Problema:** Evento `disconnected` pode disparar reconexão em paralelo durante limpeza de memória.
- **Correção:** Setar `isReconnecting = true` antes de `client.destroy()`.

---

## 🟡 Melhorias de Qualidade de Código

### CODE-01 — Dead code: `ID_DO_GRUPO_SOLICITAR_RESERVA`
- **Arquivo:** `index.js` linha 19
- **Ação:** Remover ou implementar o filtro por grupo de fato.

### CODE-02 — `clientAdapter` desnecessário
- **Arquivo:** `index.js` linhas 85–97
- **Ação:** Simplificar passando `client` diretamente ou manter o wrapper com lógica real.

### CODE-03 — Log de memória incondicional em produção
- **Arquivo:** `index.js` linha 164
- **Ação:** Tornar condicional via `process.env.DEBUG`.

### CODE-04 — Validação de data sem verificar dias válidos
- **Arquivo:** `src/handler.js` função `parseDMAY`
- **Ação:** Verificar se o dia é válido para o mês (ex: 30/02 deve ser rejeitado).

---

## 🤖 Bot Mais Inteligente

### BOT-01 — Mensagem de boas-vindas e ajuda automática
- Detectar primeira mensagem de um número e enviar o menu de ajuda.

### BOT-02 — Feedback detalhado em campos faltantes
- Em vez de silêncio, dizer: "⚠️ Faltou preencher: Dia, Hora" com o modelo correto.

### BOT-03 — Confirmação antes de criar reserva
- Enviar resumo da reserva e pedir confirmação com "Confirmar" ou "Cancelar".

### BOT-04 — Comando "Minhas Reservas"
- Filtrar reservas pelo número do usuário que enviou a mensagem.

### BOT-05 — Validação de data passada
- Impedir reservas para datas que já passaram.

### BOT-06 — Limite de reservas ativas por usuário
- Máximo configurável (ex: 3 reservas ativas simultâneas) para evitar abuso.

### BOT-07 — Suporte a variações de comando
- "reservar", "RESERVAR", "Reservar" → normalizado.
- "cancelar", "Cancelar", "CANCELAR" → normalizado.
- Detectar mensagens próximas como "reserva", "quero reservar" e redirecionar.

### BOT-08 — Locais pré-configurados
- Lista de locais válidos para evitar erros de digitação e padronizar.

---

## 🎨 Redesign do Frontend

### FRONT-01 — Design System
- Direção estética: **dark mode OLED + dashboard técnico**
- Tipografia: **Fira Code** (dados/códigos) + **Fira Sans** (corpo)
- Paleta: verde militar (#059669 accent) sobre preto profundo (#050a08)
- Inspiração: painel de operações militar/tático

### FRONT-02 — Componentes novos
- Header com logo + status do bot (online/offline)
- Cards de estatísticas (total de reservas, reservas hoje, locais)
- Calendário redesenhado com células mais expressivas
- Modal de dia redesenhado com layout melhorado
- Seções colapsáveis animadas
- Toast de feedback para erros de carregamento
- Skeleton loading enquanto carrega dados

### FRONT-03 — Acessibilidade e UX
- Contraste mínimo 4.5:1 em todo o texto
- Focus rings visíveis para navegação por teclado
- Aria-labels em todos os botões
- Mensagem de estado vazio com orientação clara
- `prefers-reduced-motion` respeitado

### FRONT-04 — Performance
- Evitar `innerHTML` para prevenir XSS
- `cache: 'no-store'` mantido + retry automático em falha
- Debounce no resize para evitar layout thrashing

---

## 📋 Ordem de Execução

1. **Fase 1 — Segurança:** BUG-01, BUG-06 (impacto direto em usuários)
2. **Fase 2 — Estabilidade:** BUG-03, BUG-04, BUG-08
3. **Fase 3 — UX do Bot:** BUG-02, BOT-01 a BOT-08
4. **Fase 4 — Frontend:** FRONT-01 a FRONT-04
5. **Fase 5 — Limpeza:** CODE-01 a CODE-04, BUG-05, BUG-07

---

## Status

- [ ] BUG-01 Cancelamento sem dono
- [ ] BUG-02 Feedback de campos faltantes
- [ ] BUG-03 Código único
- [ ] BUG-04 Race condition (mutex)
- [ ] BUG-05 Erro de fetch no frontend
- [ ] BUG-06 XSS no frontend
- [ ] BUG-07 Status "Avisado" normalizado
- [ ] BUG-08 isReconnecting antes de destroy
- [ ] CODE-01 Dead code removido
- [ ] CODE-02 clientAdapter simplificado
- [ ] CODE-03 Log de memória condicional
- [ ] CODE-04 Validação de data robusta
- [ ] BOT-01 Boas-vindas automáticas
- [ ] BOT-02 Feedback detalhado
- [ ] BOT-03 Confirmação de reserva
- [ ] BOT-04 Minhas Reservas
- [ ] BOT-05 Validação de data passada
- [ ] BOT-06 Limite por usuário
- [ ] BOT-07 Variações de comando
- [ ] BOT-08 Locais pré-configurados
- [ ] FRONT-01 Design system dark/militar
- [ ] FRONT-02 Componentes novos
- [ ] FRONT-03 Acessibilidade
- [ ] FRONT-04 Performance e segurança
