"""
Seed de dados iniciais que precisam existir no banco desde o primeiro boot —
hoje só os papéis (Role) padrão, substituindo a matriz de permissões que antes
vivia solta em data/settings.json e não era checada em lugar nenhum.
"""
import logging
from backend.database.models import Role

logger = logging.getLogger(__name__)

# Espelha o DEFAULT_PERMISSIONS que existia em routes_settings.py (agora legado),
# com o acréscimo de profile_edit_sensitive — permissão nova para editar
# foto/nome/recado do WhatsApp compartilhado (Fase 2 do plano de papéis reais).
DEFAULT_ROLE_PERMISSIONS = {
    "admin": {
        "settings_general": True, "settings_accounts": True, "settings_credentials": True,
        "settings_analytics": True, "settings_business_profile": True, "settings_users": True,
        "settings_automations": True, "feature_send_templates": True, "feature_send_media": True,
        "feature_send_interactive": True, "feature_send_products": True, "feature_send_location": True,
        "feature_send_contacts": True, "feature_qr_manager": True, "feature_export_data": True,
        "feature_view_all_chats": True, "feature_broadcast": True, "profile_edit_sensitive": True,
        "conversation_assign_others": True, "feature_view_all_accounts": True,
        "feature_attendance_agent": True,
        "settings_meta_app": True, "settings_flows": True, "settings_catalog": True,
        "settings_phone_quality": True, "admin_dashboard": True, "admin_accounts": True,
        "admin_roles": True, "admin_approvals": True, "admin_system_config": True,
        "feature_view_shared_account_chats": True,
    },
    "supervisor": {
        "settings_general": True, "settings_accounts": False, "settings_credentials": False,
        "settings_analytics": True, "settings_business_profile": True, "settings_users": False,
        "settings_automations": True, "feature_send_templates": True, "feature_send_media": True,
        "feature_send_interactive": True, "feature_send_products": True, "feature_send_location": True,
        "feature_send_contacts": True, "feature_qr_manager": True, "feature_export_data": True,
        "feature_view_all_chats": True, "feature_broadcast": True, "profile_edit_sensitive": True,
        "conversation_assign_others": True, "feature_view_all_accounts": True,
        "feature_attendance_agent": True,
        "settings_meta_app": False, "settings_flows": False, "settings_catalog": False,
        "settings_phone_quality": True, "admin_dashboard": True, "admin_accounts": False,
        "admin_roles": False, "admin_approvals": True, "admin_system_config": False,
        "feature_view_shared_account_chats": True,
    },
    "attendant": {
        "settings_general": True, "settings_accounts": False, "settings_credentials": False,
        "settings_analytics": False, "settings_business_profile": False, "settings_users": False,
        "settings_automations": False, "feature_send_templates": True, "feature_send_media": True,
        "feature_send_interactive": True, "feature_send_products": True, "feature_send_location": True,
        "feature_send_contacts": True, "feature_qr_manager": False, "feature_export_data": False,
        "feature_view_all_chats": False, "feature_broadcast": False, "profile_edit_sensitive": False,
        "conversation_assign_others": False, "feature_view_all_accounts": False,
        "feature_attendance_agent": True,
        "settings_meta_app": False, "settings_flows": False, "settings_catalog": False,
        "settings_phone_quality": False, "admin_dashboard": False, "admin_accounts": False,
        "admin_roles": False, "admin_approvals": False, "admin_system_config": False,
        # Escopo é feito por feature_view_all_accounts=False (só vê as contas
        # concedidas) + esta permissão (vê colega dentro dessas contas) —
        # não por feature_view_all_chats, que fica False pra não virar "vê
        # tudo em qualquer conta" se alguém marcar feature_view_all_accounts
        # sem querer depois.
        "feature_view_shared_account_chats": True,
    },
}

DEFAULT_ROLE_LABELS = {
    "admin": ("Admin", "#f6c026"),
    "supervisor": ("Supervisor", "#34B7F1"),
    "attendant": ("Atendente", "#25D366"),
}


def seed_default_roles(db) -> None:
    """Cria os 3 papéis padrão (is_builtin=True) se a tabela roles estiver vazia."""
    if db.query(Role).first():
        return
    for key, permissions in DEFAULT_ROLE_PERMISSIONS.items():
        label, color = DEFAULT_ROLE_LABELS[key]
        db.add(Role(key=key, label=label, color=color, permissions=permissions, is_builtin=True))
    db.commit()
    logger.info("Papéis padrão (admin/supervisor/attendant) criados na tabela roles")
