# Conectar autenticação e assinaturas do SHAPEN

## 1. Criar projeto Supabase
1. Acesse https://supabase.com/dashboard e crie um projeto para o SHAPEN.
2. Guarde a senha do banco em local seguro.
3. Em SQL Editor, abra uma nova query, copie todo o conteúdo de `supabase/schema.sql`, execute e confirme que as duas tabelas foram criadas.

## 2. Copiar as credenciais
No painel do projeto, abra Connect ou Settings → API Keys.
- Project URL → `SUPABASE_URL`
- Publishable key (ou a chave legada anon) → `SUPABASE_PUBLISHABLE_KEY`
- Secret key (ou a chave legada service_role) → `SUPABASE_SECRET_KEY`

A chave secret/service_role só pode ficar nas variáveis do servidor Render. Nunca cole essa chave no HTML, GitHub ou chat.

## 3. Variáveis no Render
No serviço SHAPEN → Environment, adicione:
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`

Mantenha as variáveis existentes `OPENAI_API_KEY` e `MERCADOPAGO_ACCESS_TOKEN`. Salve e espere o deploy ficar Live.

## 4. Configurar autenticação por e-mail
No Supabase, abra Authentication → URL Configuration.
- Site URL: `https://shapen.onrender.com`
- Redirect URLs: adicione `https://shapen.onrender.com/**`

Em Authentication → Providers, deixe Email habilitado. Se a confirmação de e-mail estiver ativa, o usuário precisa clicar no link recebido antes de entrar.

## 5. Webhook Mercado Pago
Depois de ativar a integração de notificações/webhooks no painel do Mercado Pago, configure a URL:
`https://shapen.onrender.com/api/mercadopago/webhook`

Selecione notificações de assinaturas/preapproval e pagamentos. O servidor consulta o recurso diretamente na API do Mercado Pago antes de atualizar o status no banco. Faça primeiro testes com credenciais de teste; só use produção depois de validar todo o fluxo.

## Situação e limitações
O código prepara login/cadastro, leitura de conta e assinatura, gate de assinatura e verificações de nível nos endpoints de IA. O pagamento só deve liberar o plano após a notificação verificada. O Pix é pagamento avulso de 30 dias; não renova automaticamente. O cartão usa a API de assinatura recorrente do Mercado Pago.

Antes de vender, testar cadastro, confirmação de e-mail, login/logout, checkout aprovado/recusado, notificações repetidas, cancelamento e expiração. A configuração do webhook e as credenciais precisam ser feitas no painel do usuário; não são automatizadas pelo código do repositório.
