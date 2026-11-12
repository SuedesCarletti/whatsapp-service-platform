from pydantic import BaseModel
from typing import Optional

class AccountUpdate(BaseModel):
    account_name:  Optional[str] = None
    phone_number:  Optional[str] = None
    provider_type: Optional[str] = None
    meta_phone_number_id:      Optional[str] = None
    meta_access_token:         Optional[str] = None
    meta_business_account_id:  Optional[str] = None
    bridge_host:               Optional[str] = None
    bridge_port:               Optional[str] = None
    session_id:                Optional[str] = None
