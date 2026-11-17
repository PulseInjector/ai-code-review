# Order count behavior

`OrderSummary.itemCount` returns zero for a customer without orders. The service may
represent an absent customer with either an empty list or `null`; the caller must
handle the returned value before counting items.
