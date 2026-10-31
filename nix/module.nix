{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.arnotes;

  arnotes = cfg.package;
  schemaPkg = cfg.schemaPackage;

  boolToStr = b: if b then "true" else "false";

  databaseUrl =
    if cfg.database.url != null then
      cfg.database.url
    else
      "postgresql://${cfg.database.user}:${cfg.database.password}@${cfg.database.host}:${toString cfg.database.port}/${cfg.database.name}";

  # Mirrors the Docker entrypoint: generate a 64-hex-char secret into the state
  # directory on first start, and surface it through an EnvironmentFile.
  secretScript = pkgs.writeShellScript "arnotes-secret" ''
    set -euo pipefail
    state_dir="$1"
    secret_file="$state_dir/data/.auth-secret"
    key_file="$state_dir/data/.secrets-key"
    env_file="$state_dir/env"
    umask 077
    if [ ! -s "$secret_file" ]; then
      ${pkgs.openssl}/bin/openssl rand -hex 32 > "$secret_file"
    fi
    if [ ! -s "$key_file" ]; then
      ${pkgs.openssl}/bin/openssl rand -hex 32 > "$key_file"
    fi
    : > "$env_file"
    ${lib.optionalString (cfg.betterAuth.secretFile == null) ''
      printf 'BETTER_AUTH_SECRET=%s\n' "$(tr -d '\n' < "$secret_file")" >> "$env_file"
    ''}
    ${lib.optionalString (cfg.secrets.keyFile == null) ''
      printf 'SECRETS_ENCRYPTION_KEY=%s\n' "$(tr -d '\n' < "$key_file")" >> "$env_file"
    ''}
  '';

  # Runs at service start, not evaluation, so the GitHub token and webhook secret
  # are read from the credential files and never written into the Nix store.
  githubEnvScript = pkgs.writeShellScript "arnotes-github-env" ''
    set -eu
    if [ -r "''${CREDENTIALS_DIRECTORY:-}/github-token" ]; then
      GITHUB_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/github-token")"
      export GITHUB_TOKEN
    fi
    if [ -r "''${CREDENTIALS_DIRECTORY:-}/github-webhook-secret" ]; then
      GITHUB_WEBHOOK_SECRET="$(cat "$CREDENTIALS_DIRECTORY/github-webhook-secret")"
      export GITHUB_WEBHOOK_SECRET
    fi
    exec "$@"
  '';

  appEnvironment = {
    DATABASE_URL = databaseUrl;
    BETTER_AUTH_URL = cfg.betterAuth.url;
    ALLOW_SIGN_UP = boolToStr cfg.allowSignUp;
    NUXT_PUBLIC_ALLOW_SIGN_UP = boolToStr cfg.allowSignUp;
    NUXT_PUBLIC_DISCORD_ENABLED = boolToStr cfg.discord.enable;
    NUXT_PUBLIC_GITHUB_ENABLED = boolToStr cfg.github.enable;
    NUXT_PUBLIC_GOOGLE_ENABLED = boolToStr cfg.google.enable;
    DISCORD_CLIENT_ID = cfg.discord.clientId;
    DISCORD_CLIENT_SECRET = cfg.discord.clientSecret;
    GITHUB_CLIENT_ID = cfg.github.clientId;
    GITHUB_CLIENT_SECRET = cfg.github.clientSecret;
    GOOGLE_CLIENT_ID = cfg.google.clientId;
    GOOGLE_CLIENT_SECRET = cfg.google.clientSecret;
    NUXT_PUBLIC_OIDC_ENABLED = boolToStr cfg.oidc.enable;
    NUXT_PUBLIC_OIDC_NAME = cfg.oidc.name;
    OIDC_DISCOVERY_URL = cfg.oidc.discoveryUrl;
    OIDC_CLIENT_ID = cfg.oidc.clientId;
    OIDC_CLIENT_SECRET = cfg.oidc.clientSecret;
    NUXT_PUBLIC_PASSKEYS_ENABLED = boolToStr cfg.passkeys.enable;
    NUXT_PUBLIC_EMAIL_CODE_ENABLED = boolToStr cfg.emailCode.enable;
    SMTP_HOST = cfg.smtp.host;
    SMTP_PORT = toString cfg.smtp.port;
    SMTP_SECURE = boolToStr cfg.smtp.secure;
    SMTP_USER = cfg.smtp.user;
    SMTP_PASSWORD = cfg.smtp.password;
    SMTP_FROM = cfg.smtp.from;
    VAPID_PUBLIC_KEY = cfg.push.publicKey;
    VAPID_SUBJECT = cfg.push.subject;
    GITHUB_ALLOWED_OWNERS = lib.concatStringsSep "," cfg.githubIntegration.allowedOwners;
    HOST = cfg.host;
    PORT = toString cfg.port;
    HOME = cfg.stateDir;
  }
  // cfg.environment
  // lib.optionalAttrs (cfg.betterAuth.secretFile != null) {
    BETTER_AUTH_SECRET = lib.trim (lib.readFile cfg.betterAuth.secretFile);
  }
  // lib.optionalAttrs (cfg.secrets.keyFile != null) {
    SECRETS_ENCRYPTION_KEY = lib.trim (lib.readFile cfg.secrets.keyFile);
  }
  // lib.optionalAttrs (cfg.push.privateKeyFile != null) {
    VAPID_PRIVATE_KEY = lib.trim (lib.readFile cfg.push.privateKeyFile);
  };
in
{
  options.services.arnotes = {
    enable = lib.mkEnableOption "Taskmanager";

    package = lib.mkOption {
      type = lib.types.package;
      default = (import ./packages.nix {
        inherit pkgs;
        inherit (pkgs.stdenv.hostPlatform) system;
      }).arnotes;
      defaultText = lib.literalExpression "arnotes packages.arnotes";
      description = "The Taskmanager server package to run.";
    };

    schemaPackage = lib.mkOption {
      type = lib.types.package;
      default = (import ./packages.nix {
        inherit pkgs;
        inherit (pkgs.stdenv.hostPlatform) system;
      }).schema;
      defaultText = lib.literalExpression "arnotes packages.schema";
      description = "Package providing the arnotes-db-push schema tool.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "0.0.0.0";
      description = "Address the Taskmanager server binds to.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "Port the Taskmanager server listens on.";
    };

    stateDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/arnotes";
      description = "State directory holding attachments and the generated auth and secrets keys.";
    };

    database = {
      createLocally = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Create and manage a local PostgreSQL database and role.";
      };
      url = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Full connection URL for an external database; overrides the other database options.";
      };
      user = lib.mkOption {
        type = lib.types.str;
        default = "arnotes";
      };
      password = lib.mkOption {
        type = lib.types.str;
        default = "arnotes";
        description = "Password used in the generated connection URL. Local trust auth does not check it.";
      };
      name = lib.mkOption {
        type = lib.types.str;
        default = "arnotes";
      };
      host = lib.mkOption {
        type = lib.types.str;
        default = "localhost";
      };
      port = lib.mkOption {
        type = lib.types.port;
        default = 5432;
      };
    };

    betterAuth = {
      url = lib.mkOption {
        type = lib.types.str;
        default = "http://localhost:3000";
        description = "Public application origin used by authentication.";
      };
      secretFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = "File containing a stable 32+ character secret. When null, one is generated into the state dir on first start.";
      };
    };

    secrets = {
      keyFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = "File containing the SECRETS_ENCRYPTION_KEY for project secrets: 64 hex characters from openssl rand -hex 32. When null, one is generated into the state dir on first start. Read when the configuration is evaluated, so the key ends up in the world-readable Nix store, like betterAuth.secretFile. Keep a copy apart from the database: losing it makes every stored secret unreadable.";
      };
    };

    allowSignUp = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether visitors may create accounts, by any sign-in method.";
    };

    discord = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
      };
      clientId = lib.mkOption {
        type = lib.types.str;
        default = "";
      };
      clientSecret = lib.mkOption {
        type = lib.types.str;
        default = "";
      };
    };

    github = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
      };
      clientId = lib.mkOption {
        type = lib.types.str;
        default = "";
      };
      clientSecret = lib.mkOption {
        type = lib.types.str;
        default = "";
      };
    };

    githubIntegration = {
      allowedOwners = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "acme" "acme-labs" ];
        description = "GitHub owners and orgs that links may point at. Empty allows any owner the token can see. Set it in production: the token can read every repository it has access to.";
      };
      tokenFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = "File holding the GitHub integration token (GITHUB_TOKEN), used to read issues and pull requests. Not the GitHub sign-in: that is github.clientId and github.clientSecret. Optional: public repositories work without it, at GitHub's lower rate limit. Read when the service starts, so it stays out of the Nix store.";
      };
      webhookSecretFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = "File holding the secret GitHub signs webhook deliveries with (GITHUB_WEBHOOK_SECRET), for POST /api/github/webhook. Read when the service starts, so it stays out of the Nix store.";
      };
    };

    google = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
      };
      clientId = lib.mkOption {
        type = lib.types.str;
        default = "";
      };
      clientSecret = lib.mkOption {
        type = lib.types.str;
        default = "";
      };
    };

    oidc = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Sign in through your own OpenID Connect server.";
      };
      name = lib.mkOption {
        type = lib.types.str;
        default = "Single sign-on";
        description = "Label on the sign-in button.";
      };
      discoveryUrl = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "The server's .well-known/openid-configuration URL.";
      };
      clientId = lib.mkOption {
        type = lib.types.str;
        default = "";
      };
      clientSecret = lib.mkOption {
        type = lib.types.str;
        default = "";
      };
    };

    passkeys.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Allow signing in with passkeys. Needs no outside service.";
    };

    emailCode.enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Offer \"Email me a code\" sign-in. Needs smtp.host and smtp.from.";
    };

    smtp = {
      host = lib.mkOption {
        type = lib.types.str;
        default = "";
      };
      port = lib.mkOption {
        type = lib.types.port;
        default = 587;
      };
      secure = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "TLS from the first byte (usually port 465). Off means STARTTLS.";
      };
      user = lib.mkOption {
        type = lib.types.str;
        default = "";
      };
      password = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "Ends up in the world-readable Nix store, like the OAuth client secrets.";
      };
      from = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "Taskmanager <notes@example.com>";
      };
    };

    push = {
      publicKey = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = ''
          VAPID public key for Web Push (unpadded base64url). Push notifications
          are off until this and privateKeyFile are set. Generate a pair with the
          node one-liner in .env.example.
        '';
      };
      privateKeyFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = "File holding the VAPID private key. Like betterAuth.secretFile it is read when the configuration is evaluated.";
      };
      subject = lib.mkOption {
        type = lib.types.str;
        default = "mailto:admin@localhost";
        example = "mailto:you@example.com";
        description = "Contact for push services, a mailto: or https: URL.";
      };
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Extra environment variables passed to the Taskmanager service.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open the app port in the firewall.";
    };
  };

  config = lib.mkIf cfg.enable {
    services.postgresql = lib.mkIf cfg.database.createLocally {
      enable = true;
      ensureDatabases = [ cfg.database.name ];
      # The local socket and loopback connections use trust auth, so no
      # password is needed; it is only present in the connection URL.
      ensureUsers = [
        {
          name = cfg.database.user;
          ensureDBOwnership = true;
        }
      ];
    };

    users.users.arnotes = {
      isSystemUser = true;
      group = "arnotes";
    };
    users.groups.arnotes = { };

    systemd.tmpfiles.rules = [
      "d ${cfg.stateDir} 0750 arnotes arnotes -"
      "d ${cfg.stateDir}/data 0750 arnotes arnotes -"
    ];

    systemd.services.arnotes-secret = {
      description = "Taskmanager auth secret generation";
      before = [ "arnotes.service" ];
      wantedBy = [ "arnotes.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        mkdir -p "${cfg.stateDir}/data"
        ${secretScript} "${cfg.stateDir}"
      '';
    };

    systemd.services.arnotes-db-setup = {
      description = "Taskmanager database schema push";
      after = [
        "postgresql.service"
        "arnotes-secret.service"
      ];
      requires = [ "postgresql.service" ];
      before = [ "arnotes.service" ];
      wantedBy = [ "arnotes.service" ];
      serviceConfig = {
        Type = "oneshot";
        User = "arnotes";
        Group = "arnotes";
      };
      environment = {
        DATABASE_URL = databaseUrl;
        HOME = cfg.stateDir;
      };
      script = ''
        exec ${schemaPkg}/bin/arnotes-db-push
      '';
    };

    systemd.services.arnotes = {
      description = "Taskmanager";
      after = [
        "arnotes-db-setup.service"
        "arnotes-secret.service"
        "postgresql.service"
        "network.target"
      ];
      requires = [
        "arnotes-db-setup.service"
        "arnotes-secret.service"
      ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        ExecStart = "${githubEnvScript} ${arnotes}/bin/arnotes";
        LoadCredential =
          lib.optional (cfg.githubIntegration.tokenFile != null) "github-token:${toString cfg.githubIntegration.tokenFile}"
          ++ lib.optional (cfg.githubIntegration.webhookSecretFile != null) "github-webhook-secret:${toString cfg.githubIntegration.webhookSecretFile}";
        User = "arnotes";
        Group = "arnotes";
        WorkingDirectory = cfg.stateDir;
        Restart = "on-failure";
        RestartSec = "3s";
        PrivateTmp = true;
        NoNewPrivileges = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        ReadWritePaths = cfg.stateDir;
      };
      environment = appEnvironment;
      serviceConfig.EnvironmentFile = lib.mkIf (cfg.betterAuth.secretFile == null || cfg.secrets.keyFile == null) "-${cfg.stateDir}/env";
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}