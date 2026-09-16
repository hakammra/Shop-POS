-- v77: Round automatically recalculated selling prices upward to the next LKR 50.
-- Also documented with the matching client update that restores Walk-in Customer
-- when an empty POS bill is reopened after refresh/login.
-- Run once after 076_retail_wholesale_bridge.sql.

begin;

create or replace function public.round_selling_price_up_v77(
  p_value numeric,
  p_increment numeric default 50
)
returns numeric
language sql
immutable
as $$
  select case
    when coalesce(p_value,0) <= 0 then greatest(coalesce(p_value,0),0)
    when coalesce(p_increment,0) <= 0 then round(p_value,2)
    else ceil(p_value/p_increment)*p_increment
  end;
$$;

create or replace function public.apply_stock_receiving(
  p_product_id uuid,
  p_qty numeric,
  p_unit_cost numeric,
  p_document_id uuid default null,
  p_notes text default null,
  p_movement_type text default 'purchase_receive'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  old_qty numeric(12,3);
  old_cost numeric(12,2);
  old_price numeric(12,2);
  old_markup numeric;
  new_qty numeric(12,3);
  new_avg numeric(12,2);
  new_price numeric(12,2);
begin
  if p_qty <= 0 then raise exception 'Received quantity must be greater than zero'; end if;

  insert into public.stock_balances(product_id) values(p_product_id)
  on conflict(product_id) do nothing;

  select coalesce(avg_cost,0),coalesce(selling_price,0)
  into old_cost,old_price
  from public.products where id=p_product_id for update;
  if not found then raise exception 'Product not found: %',p_product_id; end if;

  select coalesce(sellable_qty,0) into old_qty
  from public.stock_balances where product_id=p_product_id for update;
  new_qty:=old_qty+p_qty;

  if new_qty<=0 then new_avg:=coalesce(p_unit_cost,old_cost,0);
  elsif old_qty<=0 then new_avg:=coalesce(p_unit_cost,0);
  else new_avg:=round(((old_qty*old_cost)+(p_qty*coalesce(p_unit_cost,0)))/new_qty,2);
  end if;

  if old_cost>0 and old_price>0 then
    old_markup:=(old_price-old_cost)/old_cost;
    new_price:=public.round_selling_price_up_v77(new_avg*(1+old_markup),50);
  else new_price:=old_price;
  end if;

  update public.stock_balances set sellable_qty=new_qty,updated_at=now()
  where product_id=p_product_id;
  update public.products set avg_cost=new_avg,selling_price=new_price,updated_at=now()
  where id=p_product_id;
  insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes)
  values(p_product_id,p_document_id,p_movement_type,p_qty,p_unit_cost,p_notes);
end;
$$;

create or replace function public.adjust_stock_moving_average(
  p_product_id uuid,
  p_delta_qty numeric,
  p_unit_cost numeric,
  p_document_id uuid default null,
  p_notes text default null,
  p_movement_type text default 'stock_adjustment'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  old_qty numeric(12,3);
  old_cost numeric(12,2);
  old_price numeric(12,2);
  old_markup numeric;
  new_qty numeric(12,3);
  new_avg numeric(12,2);
  new_price numeric(12,2);
  internal_reapply boolean:=coalesce(current_setting('shop_pos.allow_negative_stock',true),'')='on';
begin
  if coalesce(p_delta_qty,0)=0 then return; end if;

  insert into public.stock_balances(product_id) values(p_product_id)
  on conflict(product_id) do nothing;
  select coalesce(avg_cost,0),coalesce(selling_price,0)
  into old_cost,old_price from public.products where id=p_product_id for update;
  if not found then raise exception 'Product not found: %',p_product_id; end if;
  select coalesce(sellable_qty,0) into old_qty
  from public.stock_balances where product_id=p_product_id for update;
  new_qty:=old_qty+p_delta_qty;

  if new_qty<0 and not internal_reapply then
    raise exception 'Cannot edit/reverse document because product stock would become negative. Product %, current qty %, change %',p_product_id,old_qty,p_delta_qty;
  end if;
  if new_qty=0 then new_avg:=0;
  elsif old_qty<=0 and p_delta_qty>0 then new_avg:=round(coalesce(p_unit_cost,old_cost,0),2);
  else new_avg:=round(((old_qty*old_cost)+(p_delta_qty*coalesce(p_unit_cost,0)))/new_qty,2);
  end if;

  if new_avg>0 and old_cost>0 and old_price>0 then
    old_markup:=(old_price-old_cost)/old_cost;
    new_price:=public.round_selling_price_up_v77(new_avg*(1+old_markup),50);
  else new_price:=old_price;
  end if;

  update public.stock_balances set sellable_qty=new_qty,updated_at=now()
  where product_id=p_product_id;
  update public.products set avg_cost=new_avg,selling_price=new_price,updated_at=now()
  where id=p_product_id;
  insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes)
  values(p_product_id,p_document_id,p_movement_type,p_delta_qty,p_unit_cost,p_notes);
end;
$$;

revoke all on function public.round_selling_price_up_v77(numeric,numeric) from public;
grant execute on function public.round_selling_price_up_v77(numeric,numeric) to authenticated;
grant execute on function public.apply_stock_receiving(uuid,numeric,numeric,uuid,text,text) to authenticated;
grant execute on function public.adjust_stock_moving_average(uuid,numeric,numeric,uuid,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
