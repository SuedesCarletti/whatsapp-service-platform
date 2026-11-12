<?php
/**
 * Plugin Name: WPP Lab Chat do Site
 * Description: Chat ao vivo no site integrado ao painel de atendimento WPP Lab. Identifica clientes logados (WooCommerce) e leva a conversa para o mesmo lugar do WhatsApp.
 * Version: 1.2.0
 * Requires at least: 5.8
 * Requires PHP: 7.4
 * Author: WPP Lab
 * Text Domain: wpp-site-chat
 */

if (!defined('ABSPATH')) {
    exit;
}

define('LFCHAT_VERSION', '1.2.0');
define('LFCHAT_OPTION', 'wppchat_settings');

/**
 * Configurações: o que o admin salvou sobrescreve o que veio pré-configurado
 * no zip baixado do painel (preconfig.php).
 */
function wppchat_settings() {
    $defaults = array(
        'enabled'      => 1,
        'api_base_url' => '',
        'site_key'     => '',
        'site_secret'  => '',
        'title'        => 'Fale com a gente',
        'greeting'     => 'Olá! Como podemos ajudar?',
        'color'        => '#1E293B',
        'position'     => 'right',
    );
    $pre = file_exists(__DIR__ . '/preconfig.php') ? include __DIR__ . '/preconfig.php' : array();
    if (is_array($pre)) {
        $defaults = array_merge($defaults, $pre);
    }
    $saved = get_option(LFCHAT_OPTION, array());
    if (is_array($saved)) {
        foreach ($saved as $k => $v) {
            if ($v !== '' && $v !== null) {
                $defaults[$k] = $v;
            }
        }
        if (isset($saved['enabled'])) {
            $defaults['enabled'] = (int) $saved['enabled'];
        }
    }
    return $defaults;
}

/* ───────────── Widget no front-end ───────────── */
add_action('wp_enqueue_scripts', function () {
    $s = wppchat_settings();
    if (empty($s['enabled']) || empty($s['api_base_url']) || empty($s['site_key'])) {
        return;
    }
    wp_enqueue_style('wppchat', plugins_url('assets/widget.css', __FILE__), array(), LFCHAT_VERSION);
    wp_enqueue_script('wppchat', plugins_url('assets/widget.js', __FILE__), array(), LFCHAT_VERSION, true);
    wp_localize_script('wppchat', 'LFCHAT_CONFIG', array(
        'apiBase'     => untrailingslashit($s['api_base_url']),
        'siteKey'     => $s['site_key'],
        'identityUrl' => admin_url('admin-ajax.php?action=wppchat_identity'),
        'title'       => $s['title'],
        'greeting'    => $s['greeting'],
        'color'       => $s['color'],
        'position'    => $s['position'] === 'left' ? 'left' : 'right',
        'loggedIn'    => is_user_logged_in(),
    ));
});

/**
 * Identidade assinada do cliente logado. O segredo NUNCA vai para o navegador:
 * o servidor do WordPress assina (HMAC) e o painel confere. Sem cache, e sem
 * CORS — só o próprio site lê a resposta (mesma origem).
 */
function wppchat_identity() {
    nocache_headers();
    header('Content-Type: application/json; charset=utf-8');
    $s = wppchat_settings();
    if (!is_user_logged_in() || empty($s['site_secret'])) {
        echo wp_json_encode(array('identity' => null));
        wp_die();
    }
    $user  = wp_get_current_user();
    $first = get_user_meta($user->ID, 'billing_first_name', true);
    $last  = get_user_meta($user->ID, 'billing_last_name', true);
    $name  = trim($first . ' ' . $last);
    if ($name === '') {
        $name = $user->display_name ? $user->display_name : $user->user_login;
    }
    $email = $user->user_email;
    $phone = (string) get_user_meta($user->ID, 'billing_phone', true);
    $ts    = time();
    $uid   = (int) $user->ID;
    $sig   = hash_hmac('sha256', $uid . '|' . $email . '|' . $name . '|' . $phone . '|' . $ts, $s['site_secret']);

    echo wp_json_encode(array('identity' => array(
        'wp_user_id' => $uid,
        'name'       => $name,
        'email'      => $email,
        'phone'      => $phone,
        'ts'         => $ts,
        'sig'        => $sig,
    )));
    wp_die();
}
add_action('wp_ajax_wppchat_identity', 'wppchat_identity');
add_action('wp_ajax_nopriv_wppchat_identity', 'wppchat_identity');

/* ───────────── Página de configurações ───────────── */
add_action('admin_menu', function () {
    add_options_page('Chat do Site', 'Chat do Site', 'manage_options', 'wppchat', 'wppchat_settings_page');
});

add_action('admin_init', function () {
    register_setting('wppchat', LFCHAT_OPTION, array(
        'sanitize_callback' => function ($in) {
            $in = is_array($in) ? $in : array();
            return array(
                'enabled'      => empty($in['enabled']) ? 0 : 1,
                'api_base_url' => esc_url_raw(trim(isset($in['api_base_url']) ? $in['api_base_url'] : '')),
                'site_key'     => sanitize_text_field(isset($in['site_key']) ? $in['site_key'] : ''),
                'site_secret'  => sanitize_text_field(isset($in['site_secret']) ? $in['site_secret'] : ''),
                'title'        => sanitize_text_field(isset($in['title']) ? $in['title'] : ''),
                'greeting'     => sanitize_text_field(isset($in['greeting']) ? $in['greeting'] : ''),
                'color'        => sanitize_hex_color(isset($in['color']) ? $in['color'] : '') ?: '',
                'position'     => (isset($in['position']) && $in['position'] === 'left') ? 'left' : 'right',
            );
        },
    ));
});

function wppchat_settings_page() {
    if (!current_user_can('manage_options')) {
        return;
    }
    $s = wppchat_settings();
    $o = LFCHAT_OPTION;
    ?>
    <div class="wrap">
        <h1>Chat do Site — WPP Lab</h1>
        <p>As conversas iniciadas no site aparecem no painel de atendimento, junto com os clientes do WhatsApp. Os dados de conexão estão em <em>Configurações → Contas WA</em> no painel.</p>
        <form method="post" action="options.php">
            <?php settings_fields('wppchat'); ?>
            <table class="form-table" role="presentation">
                <tr><th>Ativar chat</th><td><label><input type="checkbox" name="<?php echo esc_attr($o); ?>[enabled]" value="1" <?php checked(!empty($s['enabled'])); ?>> Exibir o botão de chat no site</label></td></tr>
                <tr><th><label>URL do painel</label></th><td><input type="url" class="regular-text" name="<?php echo esc_attr($o); ?>[api_base_url]" value="<?php echo esc_attr($s['api_base_url']); ?>" placeholder="https://painel.suaempresa.com.br"><p class="description">Endereço público (HTTPS) do painel de atendimento.</p></td></tr>
                <tr><th><label>Chave do site</label></th><td><input type="text" class="regular-text" name="<?php echo esc_attr($o); ?>[site_key]" value="<?php echo esc_attr($s['site_key']); ?>" autocomplete="off"></td></tr>
                <tr><th><label>Segredo</label></th><td><input type="password" class="regular-text" name="<?php echo esc_attr($o); ?>[site_secret]" value="<?php echo esc_attr($s['site_secret']); ?>" autocomplete="new-password"><p class="description">Usado para assinar a identidade do cliente logado. Nunca é enviado ao navegador.</p></td></tr>
                <tr><th><label>Título</label></th><td><input type="text" class="regular-text" name="<?php echo esc_attr($o); ?>[title]" value="<?php echo esc_attr($s['title']); ?>"></td></tr>
                <tr><th><label>Mensagem de boas-vindas</label></th><td><input type="text" class="large-text" name="<?php echo esc_attr($o); ?>[greeting]" value="<?php echo esc_attr($s['greeting']); ?>"></td></tr>
                <tr><th><label>Cor principal</label></th><td><input type="text" name="<?php echo esc_attr($o); ?>[color]" value="<?php echo esc_attr($s['color']); ?>" placeholder="#1E293B"></td></tr>
                <tr><th><label>Posição</label></th><td>
                    <select name="<?php echo esc_attr($o); ?>[position]">
                        <option value="right" <?php selected($s['position'], 'right'); ?>>Canto direito</option>
                        <option value="left" <?php selected($s['position'], 'left'); ?>>Canto esquerdo</option>
                    </select></td></tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}

add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($links) {
    array_unshift($links, '<a href="' . esc_url(admin_url('options-general.php?page=wppchat')) . '">Configurações</a>');
    return $links;
});
