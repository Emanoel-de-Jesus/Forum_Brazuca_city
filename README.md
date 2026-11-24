# Fórum Brazuca RP

Fórum oficial do **Brazuca RP**, um servidor de roleplay, integrado ao mesmo banco MySQL usado pela API e pela Gamemode. Contas, personagens, RG, cargos de staff e whitelist (WL) vêm direto do banco do jogo. O conteúdo do fórum (tópicos, respostas e configurações) é sincronizado em um estado compartilhado.

É um servidor Node.js **sem framework** (módulo `http` nativo) que serve o front-end estático e expõe a API em `/api/*`.

## Créditos

Este fórum foi criado por **Offzin (Eu)** e **BN_JK**.

**Uso de IA:** utilizamos ferramentas de inteligência artificial para criar algumas partes do projeto, principalmente trechos do back-end (`index.js`), do front-end e dos estilos. O código foi testado, ajustado e integrado por nós ao servidor, mas, por ter partes geradas por IA, recomendamos revisá-lo antes de usar em produção, especialmente as partes de autenticação e segurança.

## Recursos

- **Login com a conta do jogo:** nick ou e-mail + a mesma senha do Launcher/servidor. Sessão por cookie JWT (7 dias).
- **Registro com whitelist automática:** o jogador cria a conta no Launcher, confirma o e-mail no fórum com um código de 6 dígitos (válido por 10 minutos) e a WL é liberada.
- **Cargos espelhados da Gamemode:** `Membro`, `Suporte`, `Administrador` e `Fundador`.
- **Painel ao vivo** com membros, personagens, staff e usuários online no fórum.
- **Perfil do jogador** (`/api/game/profile`): personagens, banco, cartões, extrato, veículos e casas.
- **Estado do fórum compartilhado** com controle de revisão (detecta conflito entre sessões) e migração automática de um `forum-state.json` legado para o MySQL.
- **Mídia da tela de login:** administradores enviam imagem (PNG/JPG/WEBP/GIF, até 8 MB) ou vídeo (MP4/WEBM/OGG, até 100 MB) de fundo.
- **Detecção automática do schema** da tabela de contas, configurável por variáveis de ambiente.
- **Segurança básica:** rate limit nas rotas de autenticação, cabeçalhos de segurança, proteção contra path traversal no servidor estático e hash SHA-256 dos códigos de verificação.

## Requisitos

- Node.js **18+**
- MySQL/MariaDB com a tabela `players` da Gamemode/API do servidor
- Conta SMTP (para o e-mail de verificação do registro)

> A Gamemode e a API do jogo **não fazem parte deste repositório**. O fórum depende das tabelas criadas por elas (`players`, `player_characters`, `bank_accounts`, `bank_cards`, `bank_transactions`, `player_vehicles`, `houses`). A tabela `players` também precisa ter a coluna `register_ip`, usada para impedir mais de uma WL por IP.

## Estrutura

```
.
├── index.js                  # Servidor HTTP + API
├── package.json
├── .env.example              # Modelo de configuração
├── forum_brazuca.sql         # Estrutura opcional das tabelas do fórum
├── Forum bcc.html            # Front-end (página única)
├── assets/
│   ├── css/brazuca-enterprise.css
│   ├── js/brazuca-enterprise.js
│   └── uploads/              # Mídias de login enviadas pelo painel (não versionadas)
└── database/                 # Segredo JWT gerado automaticamente (não versionado)
```

O servidor serve `/` como `Forum bcc.html` (com espaço) e o HTML carrega o CSS e o JS de `assets/css/` e `assets/js/`. Mantenha esses nomes e caminhos.

## Instalação

```bash
git clone <url-do-repositorio>
cd <pasta-do-repositorio>
npm install
cp .env.example .env    # preencha com os seus dados
npm start
```

Modo desenvolvimento: `npm run dev`. Por padrão o fórum sobe em `http://0.0.0.0:3009`.

## Configuração (`.env`)

O servidor lê `.env`; se não existir, tenta um arquivo chamado `env`. **Nunca** envie o `.env` para o GitHub.

### Servidor

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3009` | Porta HTTP |
| `NODE_ENV` | — | Em `production`, MySQL e `JWT_SECRET` passam a ser obrigatórios e o cookie é `Secure` |
| `JWT_SECRET` | gerado em `database/.forum-jwt.secret` | Mínimo de 32 caracteres. **Defina em produção** |
| `SESSION_COOKIE_NAME` | `brazuca_forum_token` | Nome do cookie de sessão |

### Banco de dados

Cada variável aceita também os aliases `MYSQL_*` e `DATABASE_*`.

| Variável | Padrão | Descrição |
|---|---|---|
| `DB_HOST` | — | Host do MySQL |
| `DB_PORT` | `3306` | Porta |
| `DB_USER` | — | Usuário |
| `DB_PASSWORD` | — | Senha |
| `DB_NAME` | — | Nome do banco |
| `DB_CONNECTION_LIMIT` | `10` | Tamanho do pool |
| `DB_CONNECT_TIMEOUT` | `10000` | Timeout de conexão (ms) |

### E-mail (SMTP)

| Variável | Padrão | Descrição |
|---|---|---|
| `SMTP_HOST` | — | Servidor SMTP |
| `SMTP_PORT` | `587` | Porta |
| `SMTP_SECURE` | `false` | `true` para TLS direto (porta 465) |
| `SMTP_USER` / `SMTP_PASS` | — | Credenciais |
| `MAIL_FROM` | `SMTP_USER` | Endereço do remetente |
| `MAIL_FROM_NAME` | `Brazuca RP Fórum` | Nome do remetente |

Sem SMTP configurado, o registro com verificação de e-mail fica indisponível.

### Mapeamento do schema (opcional)

Só é necessário se a detecção automática não encontrar a sua tabela ou colunas:

`FORUM_ACCOUNTS_TABLE`, `FORUM_ID_COLUMN`, `FORUM_USERNAME_COLUMN`, `FORUM_EMAIL_COLUMN`, `FORUM_PASSWORD_COLUMN`, `FORUM_RG_COLUMN`, `FORUM_MONEY_COLUMN`, `FORUM_LEVEL_COLUMN`, `FORUM_ADMIN_COLUMN`, `FORUM_SKIN_COLUMN`, `FORUM_WL_COLUMN`, `FORUM_CREATED_COLUMN`

## Banco de dados

Na inicialização o servidor cria automaticamente, se não existirem, as tabelas `forum_email_verifications`, `forum_state_snapshots` e `forum_audit_log`. Ele também adiciona à tabela `players` as colunas `forum_email`, `forum_wl` e `forum_registered_at`.

O arquivo `forum_brazuca.sql` traz a estrutura dessas tabelas para quem preferir criá-las manualmente. As contas e personagens **não** são duplicados: continuam na tabela real da Gamemode/API.

## Fluxo de registro (WL)

1. O jogador cria a conta no Launcher/servidor.
2. No fórum, em *Registrar*, informa o nick, a **mesma senha do jogo** e um e-mail.
3. O fórum valida a conta, bloqueia IP ou e-mail que já liberaram outra WL e envia um código de 6 dígitos.
4. Ao confirmar o código, `forum_wl` é marcado e o jogador já pode entrar.

## API

| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET | `/api/health` | público | Status da conexão com o MySQL |
| GET | `/api/brazuca/overview` | público | Contadores do painel (membros, staff, online) |
| POST | `/api/auth/forum-register` | público (rate limit) | Inicia o registro e envia o código por e-mail |
| POST | `/api/auth/verify-code` | público | Confirma o código e libera a WL |
| POST | `/api/auth/resend-verification` | público | Reenvia o código |
| POST | `/api/auth/login` | público (rate limit) | Login com nick/e-mail e senha |
| GET | `/api/auth/me` | autenticado | Usuário da sessão |
| POST | `/api/auth/logout` | autenticado | Encerra a sessão |
| GET | `/api/wl/status` | autenticado | Situação da whitelist |
| GET / POST | `/api/forum-state` | GET público, POST autenticado | Lê e sincroniza o estado do fórum (com revisão) |
| GET | `/api/game/profile` | autenticado | Personagens, banco, veículos e casas |
| GET / POST | `/api/presence` | público | Usuários online no fórum |
| POST | `/api/auth-media` | Administrador/Fundador | Envia imagem ou vídeo da tela de login |

## Deploy

- Rode atrás de um proxy reverso (Nginx, Caddy, Traefik) com HTTPS e repasse o IP real do cliente. Sem o IP real, o rate limit e o bloqueio de WL por IP não funcionam.
- Se usar Docker, garanta que o container alcance o host do MySQL (`DB_HOST`).
- Faça backup do banco, de `assets/uploads/` e de `database/.forum-jwt.secret` (ou fixe `JWT_SECRET` para não derrubar as sessões a cada deploy).
- Use um supervisor de processo (PM2, systemd ou a restart policy do Docker).
- O fundo da tela de login não vem no repositório: depois de subir, envie uma imagem ou vídeo pelo painel de administração.

## Melhorias previstas

- O login ainda aceita hashes legados MD5/SHA-256 do banco do jogo, além de bcrypt e do hash da API. A ideia é migrar tudo para um hash moderno.
- Remover dependências não usadas do `package.json` (`install`, `npm` e `@node-rs/argon2`).
- Revisar o código gerado com IA e adicionar testes automatizados.

## Licença

Sem licença definida por enquanto. Todos os direitos reservados aos autores.
