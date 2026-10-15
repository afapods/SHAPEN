# SHAPEN — projeto com integração de IA

Identidade visual atualizada para preto e roxo, com acentos lilás.

Este projeto está preparado para rodar como aplicação web Node.js. Você não precisa editar código para seguir o roteiro, mas precisa criar as contas e inserir a chave privada da API no painel do serviço de hospedagem.

## O que precisa saber
- A integração com o modelo só fica ativa depois de configurar `OPENAI_API_KEY`.
- A API da OpenAI é cobrada separadamente de uma assinatura do ChatGPT.
- Nunca compartilhe a chave da API em mensagens, prints públicos ou no código do navegador.

## Caminho mais simples para publicar
1. Crie uma conta no GitHub e entre.
2. Crie um repositório novo chamado `shapen-ai`.
3. Envie os arquivos desta pasta para o repositório usando a opção **Add file → Upload files** no site do GitHub. Envie o conteúdo da pasta (incluindo `public`, `server.js`, `package.json` e `render.yaml`), não o ZIP dentro do repositório.
4. Crie uma conta no Render e escolha **New → Web Service**.
5. Conecte o repositório `shapen-ai`. O arquivo `render.yaml` já descreve o comando de instalação e inicialização.
6. No painel do serviço, abra **Environment** e adicione `OPENAI_API_KEY` com sua chave de API. Mantenha a chave privada.
7. Faça o deploy. Depois de pronto, abra a URL fornecida pelo Render.
8. Teste `/api/health`. O resultado deve mostrar `ok: true` e `aiConfigured: true` quando a variável estiver configurada.

Os nomes dos botões podem mudar com atualizações dos serviços. Plano gratuito de hospedagem pode dormir após inatividade e ter limitações; confira os termos e preços atuais antes de publicar.

## Como obter uma chave de API
1. Entre em `https://platform.openai.com/api-keys`.
2. Crie uma chave para o projeto.
3. Copie-a uma única vez e coloque-a apenas no painel Environment do host.
4. Configure o faturamento/limites de uso da API no painel da OpenAI conforme necessário. Não coloque a chave no HTML.

## O que ainda não está pronto para uso comercial em escala
- Autenticação e contas individuais.
- Banco de dados na nuvem; o perfil atual fica no armazenamento local do navegador.
- Pagamentos e gestão de assinaturas.
- Política de privacidade, consentimento, exclusão de dados, monitoramento e testes de segurança.
- Revisão de nutricionista e profissional de educação física para os fluxos de recomendação antes de comercializar.

## Segurança e saúde
A aplicação é educativa, não substitui profissionais de saúde. O backend valida alguns campos, limita o tamanho das requisições e limita frequência básica, mas ainda precisa de uma revisão profissional de segurança e privacidade antes de receber dados reais de clientes.
